# Jev Dungeon: Cloud and Multiplayer Implementation Plan (rev. 4)

## 1. Bottom line

**Build in this order: refactor and close the paid-path leaks first, then durable multi-game hosting with a cost guard, then accounts, keys and the internet-facing hardening, then cloud ops, then a shared world.** The order is unchanged from rev. 2. Since then the code has gained settings, the hub, ghost characters, the limited ghost map, adversary memory, skills and the bump/strike damage model. Three of these changes alter the plan's structure, not just its citations:

- **Game rules are process-wide.** Every tunable is an `export let` in a game module, set through `configureWorld`, `configureAdversaries` and `configureSkills` (`src/settings.js` `push()`). The `adversaryCharacters`/`limitedMap` toggles and the ghosts' `MEMORY_ON` flag are module-level too. So two games in one process cannot have different settings. The hub already works around this with one `server.js` process per instance. **Recommendation: Phase 1 runs one worker process per immutable *settings profile*, and games with the same profile share a process. A per-game `rules` object threaded through every module waits until custom per-game settings become a product need** (section 3, open question 1).
- **Persona text has nowhere to go.** `memory.objective` and `sentiment.profile_note` no longer exist, and the explorer's largest request has about 80-125 B of headroom against the `check-dungeon.mjs` size asserts (AGENTS.md "Request-size headroom is gone"). **Phase 2 agents choose from server-defined persona presets that only change numbers (mind defaults and clamps). Free persona text needs an explicit byte budget, paid for by shortening something else** (open question 3).
- **A touch is a bump, and only a claw strike takes a life.** Phase 4's combat task is rewritten around `bumpCheck`, `strikeWith` and `resolveAttack`. Skills add per-explorer state (`facing`, `block`, `strikes`, the block-roll stream) and cross-player questions, such as whose sword dispels a ghost.

**Rev. 4 (sync to commit 92fc01e) adds four more deviations, detailed in "Changes since rev. 3" at the end.** (1) A player directive (`POST /api/inject`) now puts player-written text into Jev's request, which contradicts the "no player text reaches Jev" rule. (2) The explorer has four moods (`wary`, `steady`, `greedy`, `bold`), not six, so `AgentConfig` is wrong. (3) Snapshot scope grew again: coins, `winBy`, the confidence model, the engage hold and the directive. (4) Phase 0.7 will change every request hash, so the request-hash fixtures need a planned regeneration.

The rest of rev. 2 still holds, with updated evidence:

- **Spend safety comes first.** The browser `loop()` (`public/app.js:1868` (`loop()`)) is the only thing that spends money today, so closing the tab stops it. Server-side ticking ships together with a kill switch, a daily post cap, per-game limits and pause-on-cap (Phase 1). Autoplay stays off by default.
- **One paid path only.** Both brains still default to the real Jev:
  - explorer: `askReal` and `ask ?? askReal` (`explorer/brain.js:53,300`);
  - adversary: `jevAsk` and `(ask ?? jevAsk)` at call time (`adversary/brain.js:79,393`).

  `jev.js` reads `process.env.JEV_API_KEY` on every post (`jev.js:17`). Phase 0 makes `ask`/`decide` required, and only the `JevGateway` builds real askers.
- **Multiplayer model.** Private games first, then parallel-seed races with server-secret seeds, then a shared dungeon as a competitive race, then co-op.
- **Database.** One managed Postgres (v16 or later). After each tick, the live world is committed from memory as one hot snapshot row. No Redis in v1.
- **Tick loop.** A server-side per-game actor runs it. On a deadline miss, the actor restores the brain from a pre-turn snapshot and takes a fog-safe fallback move. **New:** the abandoned turn must be unable to touch the live `Game`, because `takeTurn` calls `world.useSkill` and `world.move` after its awaits (section 3).
- **Transport.** SSE plus POST, with a fog-projected view per viewer. Reveal becomes admin-only.
- **Keys.** Bring your own key (BYOK), encrypted at rest, plus a capped platform free tier. Default hedge ×1 and retries ×1.
- **Do not expose anything to the internet until Phase 2 is done.** Today any caller can:
  - `POST /api/step` and spend the shared key;
  - `POST /api/new` and reset the game;
  - `POST /api/settings` and change the rules live;
  - on the hub, `POST /api/instances` and spawn server processes.

  The hub listens on every interface (`hub.js:234`, `server.listen(PORT, ok)` with no host). Only the instance processes bind `127.0.0.1`.

Total effort is roughly 14-19 engineer-weeks for Phases 0-3, up from 12-16 because serialize/restore has about twice the state. Phase 4 adds 7-11 weeks. Partitioning, KMS, replays and object-store tiering remain deferred (sections 6 and 11).

## 2. Context

### 2.1 The single-tenant assumptions

| # | Assumption today | Evidence | Resolution |
|---|---|---|---|
| 1 | One module-level `run` and `busy` per server process. A restart loses the game. | `server.js` (`let run`, `let busy`, `startNewGame`, `step`) | `GameRegistry` of `GameActor`s, backed by snapshots (Phase 1) and an optional DB lease (Phase 3). |
| 2 | **Game rules are process-wide state.** | `settings.js` `push()` → `configureWorld` (`dungeon.js:9-15`), `configureAdversaries` (`adversary.js:25-41`, also sets `KEEP_HUNTING_MIN`, `MEMORY_ON` in `adversary/brain.js:24,28`), `configureSkills` (`skills/config.js`, `let current`). `live` knobs change mid-game. | One worker process per immutable settings profile (Phase 1). A per-game `rules` object later (section 3). |
| 3 | One explorer per `Game`. Per-explorer state (`pos`, `health`, `graceTicks`, `trail`, `facing`, `block`, `strikes`, `skillRand`) lives on `Game`. | `dungeon.js:268-295` | Private games first. `ExplorerState` is deferred to Phase 4. |
| 4 | Fixed disk paths, or `DATA_DIR` per process. | `explorer/brain.js:45` (`MEMORY_DIR`), `turn.js:12` (`DIR`), `server.js` `GAME_OPTS`, `explorer/memory.js:289-290`, `adversary/memory.js:222` | `Store` interface, with `FileStore` kept for dev, the hub and the checks. |
| 5 | Shared env key, hedge ×2, retries ×3, 20 s timeout. | `jev.js:4-6,17,19` | `JevGateway` with a per-tenant key, policy, usage and budgets. |
| 6 | No JSON clone of a `Game` or `Adversary`. Some game state lives **outside** both, in module-level WeakMaps. | AGENTS.md rule 4; `adversary.js:62` (`views`), `:311` (`patrolRands`), `:322` (`homeDists`); `explorer/memory.js:50` (`revisitWindows`) | Explicit versioned `serialize()` and `restore()` that also cover the WeakMap state. |
| 7 | Determinism: option shuffles use global `Math.random`. | `jev.js:52-58` | Inject a seeded `rand` per actor. |
| 8 | The browser drives ticks. | `app.js:1868` (`loop()`), `server.js` `/api/step`, `turn.js` `playTurn` | Server `TickScheduler`, with cost guards. |
| 9 | Shared-world fog and combat assume one explorer. | `adversary.js` `seesExplorer`, `startsChase`, `bumpCheck`, `strikeWith`, `alertNearby`, `stepAdversaries`; `skills/resolve.js` | No mutual visibility in shared-world v1. Per-explorer combat in Phase 4. |
| 10 | Both brains default to the real Jev. | `explorer/brain.js:53,300`; `adversary/brain.js:79,393` | Make `ask` and `decide` required (Phase 0). |
| 11 | Hub and settings APIs have no auth, and the hub binds every interface. | `hub.js:191-197,234`; `server.js` `/api/settings` | Dev-only tools. They never ship to the internet as they are (Phase 2). |

### 2.2 Facts established from the code

The code wins (AGENTS.md rule 3).

- **AGENTS.md now matches the code constants**: `ADVERSARY_SPEED = 0.6`, `MAX_SEARCH_TICKS = 18`, `ALERT_STEPS = 24`, `FLOOR_PER_ADVERSARY = 150`, `MAX_ADVERSARIES = 12` (`adversary.js:25-34`). Rev. 2's drift list is resolved. These are only defaults, though: the settings page allows `maxAdversaries` up to **24** and `floorPerAdversary` down to 40. Size every cap from a game's frozen settings, never from the code default.
- **The grace comment is still stale.** `adversary.js:28-29` says "1/ADVERSARY_SPEED = 2 ticks", which is wrong at speed 0.6 (it takes 2 ticks only at 0.5).
- **The forced move.**
  - The explorer path is still dead: `availableMoves()` returns `[...steps, STAY]` whenever any step exists (`dungeon.js:337-340`), and `takeTurn` throws on an empty list (`explorer/brain.js:342`). So `forced = legal.length === 1` (`:343`) is never true for the explorer. Every explorer tick costs at least one logical Jev call.
  - The `forced` branches are now **kept on purpose**: they carry the skills D4 skill-only request (AGENTS.md "Forced ticks"). That path is dormant for the explorer and live for ghosts.
  - A ghost with one legal move and the explorer in strike range sends a skill-only request (`adversary/brain.js:303-376`). A ghost with no questions makes no call (`:376,388`).
- **Light is derivable from `visits`.** `lightAround` (`dungeon.js:209`) is the only writer of `light`, and it takes the max, so the result depends only on the set of visited cells. Restore replays it. **`LIGHT_RADIUS` is a `next` setting**, so restore must use the game's frozen radius, not the process value.
- **Adversary step order is numeric**: `byId` uses `localeCompare(..., { numeric: true })` (`adversary.js:554`).
- **Runtime files are gitignored and untracked.** The hub's `runs/` folder is gitignored too.
- **Network tripwire coverage (re-audit in rev. 4).** Several newer scripts (`check-duels`, `check-confidence*`, `check-inject`, `measure-outnumbered`, `calibrate-confidence`) get it through `scripts/lib/duel-harness.mjs` or `request-hashes.mjs`, not their own `globalThis.fetch` line; task 0.1 must confirm each one, including scripts that import neither. Original list: `check-dungeon`, `check-adversaries`, `check-testbed`, `check-characters`, `check-skills` and `measure-memory` install it. `check-props`, `check-memory-kit`, `run-testbed` (dry mode) and `arenas.mjs` do not. `arenas.mjs` makes only localhost calls to the hub.
- **Global `Math.random` swaps are now in 12 scripts, 47 assignments (rev. 4 sweep), not 4.** `check-dungeon.mjs` 11, `check-adversaries.mjs` 6, `check-skills.mjs` 6, `check-confidence-caps.mjs` 4, `check-confidence-wiring.mjs` 4, `check-inject.mjs` 4, and 2 each in `calibrate-confidence`, `measure-caps`, `measure-memory`, `measure-confidence`, `request-hashes` and `lib/duel-harness.mjs`. The request-hash baseline and the duel harness depend on a seeded global `Math.random`.
- **Ghost load.**
  - `alertNearby` switches on every patrolling packmate within `ALERT_STEPS` path steps.
  - A brain-on ghost with `budget >= 1` and no stun calls Jev, all ghosts in parallel (`adversary.js:585`). That is about 60% of ticks at speed 0.6.
  - Stunned ghosts make no call. Dispelled ghosts are removed from `game.adversaries`.
  - Worst case per tick: `maxAdversaries` ghost calls (up to 24) plus 2 explorer calls, before hedging and retries.
- **Every RNG stream that persisted state must cover:**
  - dungeon `rng(seed)` and spawn `rng(seed ^ 0x9e3779b9)`: both derivable;
  - character assignment `rng(seed ^ 0x6a09e667)` (`character.js:123`): derivable, used once at spawn;
  - patrol: `game.patrolRand` (toggle off) or per-ghost `patrolRands` (toggle on, `adversary.js:311-316`);
  - block rolls: `game.skillRand` (`dungeon.js:319-322`);
  - coin drops: `game.coinRand` (`seed ^ 0x3c6ef372`, created on the first `coinRandom()`; **new in rev. 4**, needs a draw-count wrapper like the others);
  - opening coins `rng(seed ^ 0x5be0cd19)` (`src/coins.js`): derivable, used once at spawn;
  - the testbed stream `seed ^ 0x51ed27a3`: derivable;
  - option shuffles: `Math.random`.
- **Late answers mutate the live world.** `takeTurn` awaits the sentiment and tick requests, *then* calls `#useSkill` (a strike can dispel a ghost) and `world.move(dir)`, then awaits `#save()` (`explorer/brain.js:462-508`). If a deadline-missed brain instance is simply dropped, its late answer still drives a real `KnownWorld` over the live `Game`. Rev. 2's claim that "late promises hit a dead object" was wrong (section 3).
- **The renderer reads `game.seed`** to derive wall and decor heights (`app.js:316,325`), and reads `explored_pct` (`app.js:1510,1940`). Both are leak-surface fields (section 10).

### 2.3 Unverified, to be tested or measured

- Whether TypeSafe bills an aborted hedge copy. Plan quotas on HTTP posts, not logical calls.
- Event-loop blocking from synchronous BFS under many games. The limited-map views add per-ghost line-of-sight scans each tick (`AdversaryView.update`). Measure first.
- The Jev latency distribution (p50 and p95), which sets the deadline `D` and `tickMs`. Measure it with one protected, budget-capped staging run.
- The memory footprint of one `server.js` process with N games, which sizes the profile-per-process model.

## 3. Decisions taken

| Topic | Decision | Conflict resolved |
|---|---|---|
| Multiplayer order | Private games, then parallel-seed races, then a shared world (race rules), then co-op. | |
| **Rules scope** | **Phase 1: a *settings profile* is an immutable, hashed set of every `SCHEMA` value. Each worker process applies one profile at boot and never changes it. A game records its `profile_id` and runs in a worker for that profile. `live` edits are dev-only; in the cloud, a change creates a new profile. Later (only on need): per-game `rules` passed through `Game`, `Adversary`, `SkillSet` and the brains, retiring the `configure*` setters.** | Two games in one process with different settings is impossible today. The hub already uses process isolation. Threading `rules` through every module is large and touches every owner's files. |
| Database | Postgres only. JSONB for opaque snapshots, normalized tables for what we query, bill or audit. | Redis rejected for v1. |
| Snapshot write path | Synchronous transactional commit per tick, before publishing. One hot `game_state` row fenced by `expectTick` (and by the lease from Phase 3). Cold snapshots every 25th tick. | |
| Terminology | Keep the code class `Run` (`turn.js`). The DB container is `game` (`gm_`). A participant's tenure is `par_`. | |
| Patrol and skill RNG state | Phase 0: draw-count wrappers on `game.patrolRand`, each per-ghost `patrolRands` stream and `game.skillRand`. They must not change draw order. Later: an optional `{next, state}` object. | AGENTS.md rule 8. |
| Shuffle RNG | `shuffle(items, rand = Math.random)`. `rand` is injected through the `Run`, `ExplorerBrain` and `stepAdversaries` opts, one stream per actor seeded from `(game seed, actor id)`, with its draw count persisted. | Every `Math.random` swap in the scripts (12 files) switches to injected `rand` in the same change. |
| Seeds | Generated by the server with `crypto.randomInt` and stored in `games.seed`. `randomSeed()` (`dungeon.js:57` (a private, unexported function)) is unused by the server. | |
| API shape | `/v1/games/:id/...`. The old `/api/*` stays only as a dev shim. | |
| Auth | Hosted OIDC (magic link and one OAuth provider). Cookie sessions with CSRF protection. | |
| Transport | SSE plus POST. Resume via `Last-Event-ID`. Heartbeat 15 s. Per-user SSE cap. Slow-client backpressure. | |
| Jev policy | Cloud default: hedge 1, retries 1, attempt timeout equal to the remaining deadline. Hedge ×2 is opt-in per tenant. | Cuts the worst case from 8 posts per call to 2. |
| Tick timing | `tickMs` is a floor. `D = min(configured D, 0.8 × tickMs)`, and `D` must fit a decision tick's two serial requests. The defaults (`tickMs` 5 s, `D` 4 s) are placeholders until the latency run. | |
| Deadline miss handling | **Before the turn, snapshot the brain and give `takeTurn` a *turn-scoped, revocable* `KnownWorld` plus an AbortSignal-aware `ask`. On a miss:** (1) abort, so the wrapped `ask` **rejects unconditionally**, even if an HTTP answer arrives later; (2) revoke that turn's world, so every mutating call (`move`, `useSkill`) throws; (3) discard the brain, restore it from the snapshot over a fresh world, apply `fallbackMove`, and keep `pending` set so the decision is re-asked next tick. | The rejecting `ask` alone would stop the late mutation. The revoked world is the safety net, and a check proves it. |
| Ghost-call billing | Private games: the owner pays. Shared worlds: decided in Phase 4 (open question 6). A hard per-game cap always applies. | |
| Agent model | Agent = `AgentProfile` (versioned, immutable `agent_versions`) + credential. **v1 personas are server-defined presets that set numbers only** (default mind, `min_gap`/`end_ticks` overrides inside clamps, review cadence). No free text reaches Jev until a byte budget is agreed. | No `objective` or `profile_note` field exists any more, and the request-size headroom is about 100 B. |
| Ghost characters and limited map | Profiles may turn `adversaryCharacters` and `limitedMap` on. Both stay off in the default cloud profile until a live run validates them (AGENTS.md open issues). | |
| Key model | BYOK as the main path, plus a capped platform key. Keys are decrypted only inside the gateway. | |
| Key encryption | AES-256-GCM with one app key from the secret manager. KMS deferred. | |
| Reveal | Admin only, or the game owner in a non-competitive game, always audited. Reveal-only fields (ghost `character`, `hp`, `facing`, `brain`) leave the default view. | |
| Shared-world fog (v1) | Players cannot see each other. `visibleExplorers()` is a Phase 5 opt-in. | |
| Dungeon persistence | Store `seed`, `gen_version`, `profile_id` (map size, room area and spawn density shape the dungeon) and a `tiles_hash`. Pin the serialized tiles and props for long-lived games. | AGENTS.md rule 8. Settings also change the dungeon. |
| Dependencies | The zero-dependency rule ends deliberately: `pg` plus a migration tool. | |
| `memory.md` and `adversaries.json` | Dropped from the write path. Rendered on demand from the stored memories. | |
| The hub | Stays a **dev and testing tool** (arenas, gyms, A/B settings). In the cloud, its process-per-profile idea is reused, but not its unauthenticated management API. | |
| Data-model scope | Phases 1-2 keep one hot JSONB snapshot per game, periodic snapshots and `jev_calls` metadata. Everything else is deferred. | |

**Why snapshot/restore instead of plan/commit (unchanged).** A side-effect-free `plan()` cannot exist. A decision tick is two serial requests, and the second body includes memory already updated by the first answer: `takeTurn` sets `info.lastDecision` before awaiting `#askSentiment` (`explorer/brain.js:362-363`), and `#state` reads the new sentiment for the tick request (`:439`). The world mutations, however, are confined to the tail of `takeTurn` (`#useSkill`, `world.move`). That is why a revocable world can fence them without splitting the brain.

## 4. Naming and ID scheme

### 4.1 ID format

**Prefixed ULID: `<prefix>_<26-char lowercase Crockford base32>`**, stored as `text` with a `CHECK` regex. High-volume ledgers (`jev_calls`, `events`) use `bigint identity` plus the natural key `(game_id, tick, seq)`.

| Entity | Prefix | Notes |
|---|---|---|
| Account | `acc_` | Billing and login principal. |
| Player | `plr_` | In-game identity. One account can have several. |
| Agent | `agt_` | A configured Jev explorer. |
| Agent version | `agv_` | Immutable. Pinned per participant. |
| Settings profile | `prf_` | Immutable `SCHEMA` value set (section 3). |
| API key row | `key_` | Row id only. |
| Game | `gm_` | A private game or a shared world. |
| Participant | `par_` | One explorer's tenure in a game. |
| Snapshot | `snp_` | |
| API token | `tok_` | Stored hashed. |

**Adversary ids stay `a1..aN`**, unique within a game and stored as `(game_id, adv_id)`. A dispelled ghost's id is never reused within the game. Add a check asserting the `byId` order for `a2` and `a10`.

### 4.2 Human-facing names

- **Handle** (`plr`, `agt`): `[a-z0-9][a-z0-9-]{2,23}`, unique case-insensitively, with a reserved-word list (`admin`, `api`, `jev`, `system`, `arena`, `gym`).
- **Display name**: 1-40 chars, NFKC-normalized, control and bidi characters stripped.
- **Agent name**: unique per player.
- **Game slug**: a join code such as `amber-ghost-42`, used only in invite URLs.

### 4.3 Database conventions

`snake_case`, plural tables, `<table_singular>_id` foreign keys, `timestamptz` `*_at`, integer micro-unit money, `CHECK` enums, snake_case JSONB keys, `ix_`/`ux_` index names.

### 4.4 Object-store layout (deferred)

```
s3://jev-dungeon-<env>/
  snapshots/{gm_id}/{tick:08d}.json.zst
  exports/{acc_id}/{yyyymmdd}/{export_id}.zip
```

### 4.5 Environment variables

| Var | Purpose |
|---|---|
| `JD_DATABASE_URL`, `JD_DB_POOL_MAX` | Postgres. |
| `JD_APP_KEY` | Encrypts stored BYOK keys (secret manager; dev from env). |
| `JD_NODE_ID` | Lease owner id (Phase 3). |
| `JD_PROFILE_ID` | **New.** The settings profile a worker process runs. It replaces `loadSettings(<file>)` in the cloud. |
| `JD_JEV_BASE_URL`, `JD_JEV_HEDGE`, `JD_JEV_RETRIES`, `JD_JEV_TIMEOUT_MS` | Replace the constants at `jev.js:3-6`. |
| `JD_PLATFORM_JEV_API_KEY` | Platform key, renamed from `JEV_API_KEY` with a transitional alias. Read only by the gateway. |
| `JD_JEV_LIVE=1` | The only way to enable the paid gateway, and the platform kill switch. |
| `JD_DAILY_POST_CAP` | Platform-wide daily cap on Jev HTTP posts. **With several worker processes it is a Postgres counter** (`UPDATE ... RETURNING`), not an in-memory one. |
| `JD_GAME_MAX_TICKS`, `JD_GAME_MAX_POSTS` | Per-game limits. |
| `JD_AUTOPLAY` | Default off. |
| `JD_TICK_MS`, `JD_DEADLINE_MS`, `JD_MAX_INFLIGHT` | Scheduler and gateway limits. |
| `JD_SNAPSHOT_EVERY` | Cold-snapshot cadence (default 25). |
| `JD_RETENTION_*` | Retention windows (Phase 3). |
| `PORT`, `HOST`, `DATA_DIR`, `TESTBED` | Existing (`server.js`), unchanged for dev and the hub. |

- `process.loadEnvFile('../.env')` and the hard `JEV_API_KEY` throw (`server.js:10-11`) become a dev-only branch. In production a missing key fails at boot with a message that never prints values. Never read or print `../.env`.

## 5. Target module layout

New files are marked (new). Ownership follows AGENTS.md rule 9.

```
server.js                         HTTP, STATIC whitelist, routes, boot, shutdown (one worker = one profile)
hub.js                            dev/test only: unchanged role, bound to 127.0.0.1 by default
src/config.js (new)               validated env config, fail fast
src/settings.js                   SCHEMA + validate; new: profileOf(values) -> {id, hash, values}, applyProfile() once at boot
src/jev.js                        transport only: apiKey, policy, signal, onAttempt; returns {answers, usage}; no env read
src/runtime/
  registry.js (new)               GameRegistry: Map<gameId, GameActor>, lazy load, evict, profile check
  actor.js (new)                  GameActor: per-game tick loop, the only mutator, per-game try/catch isolation
  scheduler.js (new)              deadline race, revocable turn world, overrun skipping, degraded-player counter
  jev-gateway.js (new)            the only builder of real ask/decide: metering, budgets, kill switch, semaphore, breaker
  view-projector.js (new)         per-viewer fog-safe views and deltas
  sse-hub.js (new)                SSE fan-out (named to avoid confusion with hub.js)
src/store/
  store.js, file-store.js, memory-store.js, pg-store.js (new)
  migrations/ (new)               SQL plus snapshot-JSON migrations
src/ids.js (new)                  prefixed ULID, handle validation
src/agents/profile.js (new)       AgentProfile presets, validation, clamps
src/characters/explorer/fallback.js (new)   fog-safe fallbackMove(world)
src/characters/explorer/known-world.js      new: revoke() (mutators throw afterwards)
src/characters/explorer/brain.js  serialize(), static restore(), required ask, injected rand
src/characters/adversary/adversary.js       Adversary serialize()/restore(); views/patrolRands state exported for snapshot
src/characters/adversary/adversary-view.js  serialize()/restore() of the limited K (#seen stamps, #forgotten)
src/skills/skill.js, skill-set.js           serialize()/restore() of cooldowns and uses
src/dungeon.js                    Game.serialize(), static restore(), rng draw-count wrappers (no new relative imports)
scripts/lib/no-network.mjs (new)  shared throwing fetch tripwire
scripts/check-persistence.mjs, check-runtime.mjs, check-views.mjs, check-paid-paths.mjs (new)
.github/workflows/ci.yml (new)    no secrets, egress blocked
```

Constraints:

- Explorer files import nothing from `src/store/` or `src/runtime/`. Storage and Jev access are injected.
- `dungeon.js` keeps exactly one relative import, `import { placeProps } from './props/place.js';`, byte-identical (`check-props.mjs` copies the file alone).
- `fallback.js` lives in the explorer chain, so the static guard scans it. Skills code keeps its own guard (section 0c).
- `check-paid-paths.mjs` greps that `askJev(` appears only in `jev.js` and `jev-gateway.js`, and that neither brain has a default asker.

## 6. Database schema

All DDL is illustrative Postgres. Phases 1-2 use the reduced set below.

### 6.1 Identity and access (Phase 2)

```sql
CREATE TABLE accounts (
  id text PRIMARY KEY,                        -- acc_
  email citext UNIQUE NOT NULL,
  auth_subject text UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);

CREATE TABLE players (
  id text PRIMARY KEY,                        -- plr_
  account_id text NOT NULL REFERENCES accounts(id),
  handle citext NOT NULL,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX ux_players_handle ON players (lower(handle));

CREATE TABLE api_keys (
  id text PRIMARY KEY,                        -- key_
  owner_account_id text NOT NULL REFERENCES accounts(id),
  label text NOT NULL, provider text NOT NULL DEFAULT 'typesafe-jev',
  ciphertext bytea NOT NULL, nonce bytea NOT NULL, app_key_version int NOT NULL,
  last4 text NOT NULL, fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','failing')),
  created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz);
CREATE UNIQUE INDEX ux_api_keys_owner_fp ON api_keys (owner_account_id, fingerprint);
```

Key rules:

- AES-256-GCM. Plaintext exists in memory only for one call.
- A key is never logged, never stored in a snapshot or `state`, and never sent to the browser.
- The API returns `{id, label, last4, status}` only.
- Rotation creates a new row. Revocation is soft and fails closed.
- A new key is validated with one cheap Jev call, rate-limited.
- Disclosure: memory, situation text and ghost requests go to TypeSafe. Request-body logging is opt-in per owner.

### 6.2 Settings profiles and agents

```sql
CREATE TABLE settings_profiles (              -- Phase 1, immutable
  id text PRIMARY KEY,                        -- prf_
  values jsonb NOT NULL,                      -- every settings.js SCHEMA key, validated by settings.validate()
  values_hash text UNIQUE NOT NULL,
  label text, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE agents (                         -- Phase 2
  id text PRIMARY KEY,                        -- agt_
  player_id text NOT NULL REFERENCES players(id), name text NOT NULL,
  current_version_id text, default_key_id text REFERENCES api_keys(id),
  created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  UNIQUE (player_id, name));
CREATE TABLE agent_versions (                 -- immutable
  id text PRIMARY KEY,                        -- agv_
  agent_id text NOT NULL REFERENCES agents(id), version int NOT NULL,
  config jsonb NOT NULL, config_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (agent_id, version));
```

`AgentConfig` (schema 1):

```jsonc
{ "schema": 1,
  "persona": "steady",                          // server-defined preset id, never free text
  "default_sentiment": "steady",                // one of MOOD_IDS: wary, steady, greedy, bold (memory.js:57)
  "sentiment_overrides": { "steady": { "min_gap": 3, "end_ticks": 4 } },
  "review_every": 8, "redecide_cooldown": 3,
  "skills": "default",                          // 'default' | 'none' | up to 4 loadout ids (as testbed explorerSkills)
  "model": "jev-latest" }
```

- Clamps: `min_gap` 1..6, `end_ticks` 1..8, `review_every` 4..16, `redecide_cooldown` 1..6. `model` is an allow-list; it is hard-coded today (`jev.js:40` and both brains' request bodies).
- These constants become defaults a profile overrides: `SENTIMENTS` (`explorer/brain.js:59`), `DEFAULT_SENTIMENT` (`:111`), and `REVIEW_EVERY`, `APPROACH_FAILING`, `REDECIDE_COOLDOWN` (`:34-36`). Text fields of `SENTIMENTS` (`priority`, `move_priority`, `skill_priority`, `when`, `note`) are **not** overridable.
- **No agent-config field reaches Jev as text.** (The player directive is the one exception, see section 12.) Persona text needs a new state field, and the request-size asserts (≤ 9500 B chasing, ≤ 10500 B patrolling; measured 9421 / 10374 B) leave little room (rev. 4: about 250 B chasing / 670 B patrolling left against the unchanged 9500 / 10500 asserts, AGENTS.md "Request-size headroom"). Adding any text means shortening something first and recording the raise in AGENTS.md (open question 3).
- No config field may reach a `KnownWorld` read path or change fog behaviour.

### 6.3 Games and participants (Phase 1 creates `games`; participants from Phase 2)

```sql
CREATE TABLE games (
  id text PRIMARY KEY,                        -- gm_
  slug text UNIQUE,
  mode text NOT NULL CHECK (mode IN ('private','shared')),
  status text NOT NULL CHECK (status IN ('lobby','running','paused','finished','abandoned')),
  pause_reason text,                          -- 'user'|'budget'|'auth'|'cap'|'kill_switch'|'idle'|'error'
  world_kind text NOT NULL CHECK (world_kind IN ('generated','testbed')),
  seed bigint NOT NULL,                       -- server-generated (crypto), never sent to clients
  testbed_config jsonb,                       -- normalizeConfig output, incl. characters, explorerSkills, ghostSkills, ghostHp
  profile_id text NOT NULL REFERENCES settings_profiles(id),
  gen_version text NOT NULL, tiles_hash text, dungeon_blob_ref text,
  rules_version text NOT NULL,
  tick int NOT NULL DEFAULT 0,
  rng_state jsonb NOT NULL,                   -- {patrol, patrol_by_ghost:{aN}, skill, shuffles:{actorId}} as draw counts
  tick_ms int NOT NULL, deadline_ms int NOT NULL,
  autoplay boolean NOT NULL DEFAULT false,
  max_ticks int NOT NULL, max_posts int NOT NULL,
  owner_node text, lease_expires_at timestamptz, lease_epoch bigint NOT NULL DEFAULT 0,  -- Phase 3
  created_by text NOT NULL REFERENCES players(id),
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz);

CREATE TABLE game_participants (
  id text PRIMARY KEY,                        -- par_
  game_id text NOT NULL REFERENCES games(id),
  player_id text NOT NULL REFERENCES players(id),
  agent_version_id text NOT NULL REFERENCES agent_versions(id),
  key_id text NOT NULL REFERENCES api_keys(id),
  slot int NOT NULL,                          -- deterministic apply order
  status text NOT NULL CHECK (status IN ('joined','alive','won','dead','left','kicked','degraded')),
  joined_tick int NOT NULL, ended_tick int, outcome jsonb, budget_micro bigint,
  UNIQUE (game_id, slot), UNIQUE (game_id, player_id, joined_tick));
```

`games.constants` from rev. 2 is replaced by `profile_id`: the profile holds every tunable, not a hand-picked subset. In private mode there is exactly one participant per game.

### 6.4 State and events

```sql
CREATE TABLE game_state (                     -- hot row, one write per tick
  game_id text PRIMARY KEY REFERENCES games(id),
  tick int NOT NULL, schema_version int NOT NULL, world jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE game_snapshots (                 -- every 25th tick plus first and last
  id text PRIMARY KEY, game_id text NOT NULL REFERENCES games(id), tick int NOT NULL,
  schema_version int NOT NULL, body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (game_id, tick));
CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id text NOT NULL, tick int NOT NULL, seq int NOT NULL, par_id text,
  type text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, tick, seq));
```

- `game_state.world` holds the whole restorable state: `Game`, adversaries (with their views and skills), the explorer brain and memory, and the adversary memories. The per-tick move source (`jev`, `fallback`, `cap_fallback`) is a `move_source` event.
- Event `type` strings are exactly today's:
  - sighting and brain: `spotted`, `brain_on`, `brain_off` (with `reason`), `lost_sight`, `alerted`;
  - touch: `bump`;
  - explorer skills: `strike`, `struck` (with `hp`), `dispelled`;
  - ghost skills: `strike`, `blocked`, `hit` (`{id, at, health}`), `caught`.

  No `gave_up` event exists, and a touch never emits `hit`.

### 6.5 Jev calls, ledger, quotas

```sql
CREATE TABLE jev_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id text NOT NULL, tick int NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('explorer','adversary')),
  actor_id text NOT NULL,                     -- par_ id or a1..aN
  kind text NOT NULL,                         -- sentiment|tick|adversary|adversary_skill
  billed_to_account text NOT NULL, key_id text NOT NULL,
  request_sha text NOT NULL, request_bytes int NOT NULL, request_body text,   -- body only when the owner opted in
  answers jsonb,
  status text NOT NULL CHECK (status IN ('ok','error','timeout','deadline_fallback','budget_denied','breaker_open','kill_switch','auth_failed')),
  error_class text CHECK (error_class IN ('transient','auth','budget','other')),
  error text, attempts int NOT NULL, copies int NOT NULL, winner_copy int, api_ms int,
  cost_micro bigint NOT NULL DEFAULT 0, unit_price_micro int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX ix_jc_game_tick ON jev_calls (game_id, tick);
CREATE INDEX ix_jc_acct_time ON jev_calls (billed_to_account, created_at);
CREATE TABLE quotas (account_id text PRIMARY KEY, daily_cap_micro bigint, per_game_cap_micro bigint,
  per_tick_attempt_cap int NOT NULL, updated_at timestamptz);
```

- **Billing unit is HTTP posts.** `attempts` counts every post, including aborted hedge losers and retries. The worst case today is `HEDGE × (RETRIES+1) = 8` posts per logical call.
- **`per_tick_attempt_cap` comes from the game's profile:** `(maxAdversaries + 2) × posts_per_call`. That is 28 posts at the default 12 ghosts with hedge 1 and retries 1, and 52 at the settings maximum of 24. A cap below that forces ghosts onto `codeHuntDir` (behaviour drift). Where a cap binds, emit `cap_fallback`. Profiles above a platform ceiling on `maxAdversaries` are refused at creation.
- `request_bytes` is kept because request size is already a tracked quality bound (`measure-memory.mjs`).
- Deferred: `usage_rollups`, `replays`, `handle_history`, partitioning.
- `audit_log(id, actor_account, action, subject_type, subject_id, at, meta jsonb)` covers key changes, quota changes, profile creation, Reveal and spectator access, and deletions (Phase 2).

## 7. Snapshot, restore and determinism rules

**Never use `JSON.parse(JSON.stringify(game))`, `{...game}`, `structuredClone`, or a spread of an `Adversary`** (AGENTS.md rule 4). `game.litOutside` is a `Set`, the methods live on the prototype, and `Adversary`, `AdversaryView`, `Skill` and `ExplorerBrain` keep their state in `#private` fields.

### 7.1 `Game`

- `serialize()` emits:
  - movement and lives: `steps, pos, health, maxHealth, graceTicks, won, lost, caughtBy, trail, visits (ordered), litOutside (sorted array)`;
  - adversary bookkeeping: `adversaryTicks, patrolRand: {draws}`;
  - skills: `facing, block, skillRand: {draws}`;
  - coins and victory (rev. 4): `coinPiles` (ordered array, one entry per coin), `coins`, `coinRand: {draws}`, `winBy` (`'chest'` | `'cleared'` | `null`).

  `strikes` is per-tick and cleared by `clearTickState()`, but a snapshot taken after a tick holds that tick's strikes for the view, so serialize it too. Placement is in `dungeon.js` with no new relative imports.
- `static restore(dungeon, snap, profile)` builds through `new Game(dungeon)`, then overwrites fields. `light`, `knownCount` and `knownFloor` are recomputed by replaying `lightAround` over `Object.keys(visits)` **with the profile's `lightRadius`**. The constructor reads the live `LIGHT_RADIUS` and `EXPLORER_LIVES`, so the worker must have applied the game's profile first; restore refuses a mismatch.
- `game.adversaries` is restored separately (7.2), in id order.
- The dungeon is not in the snapshot. It is rebuilt from `seed`, `gen_version` and the profile (`generateDungeon` reads `MIN_SIZE`, `MAX_SIZE` and `ROOM_AREA`), or from `testbed_config` (`buildArena`). `tiles_hash` is checked. Long-lived games pin the blob (tiles, rooms, props, decor) and fail loudly on a mismatch.

### 7.2 `Adversary` and its world-side state

- Keep the six public fields in order (`id, pos, mode, budget, lastSeen, goal`). Add no public fields.
- `serialize()` emits `{schema, public, character, home, hp, maxHp, stun, facing, skills, hunt, route}`:
  - `hunt` is the `newHunt` state, including `memory` (with `sightings`, `recent`, `landmarks`, `lifetime`) and the private `probabilities`;
  - `skills` is the `SkillSet` state (7.5).
- `static restore()` constructs through `new Adversary({ id, pos: home, character, hp, skills })` so that `#home` and `#profile` come out right, then sets `pos` and the private state through restore-only setters. `lastRequestBody` is audit-only and is not restored.
- **The `adversary.js` WeakMaps hold state too:**
  - `views` → `AdversaryView`. In limited mode it holds `#seen` (cell → tick stamp, in insertion order, which the eviction relies on) and `#forgotten`. `#home` is rebuilt from geometry. `#inView`/`#viewAt` are a cache and are recomputed.
  - `patrolRands` → per-ghost patrol streams (characters on): store their draw counts.
  - `homeDists` → a derivable cache. Do not store it.

  Export narrow `snapshotAdversaryWorld(game)` / `restoreAdversaryWorld(game, snap)` helpers from `adversary.js` instead of exposing the maps.
- A dispelled ghost is absent from `game.adversaries`, so it is absent from the snapshot. Its id stays retired.

### 7.3 `ExplorerBrain`

- The constructor builds fresh memory, runs `approachTarget` and sets `pending = 'start'`. `restore` must **bypass** it (a private `{restoreFrom}` init path), or it pays for an extra `start` decision.
- Snapshot content:
  - `memory` (plain JSON, validated by `saveMemory`'s rules, now including `skills`);
  - `revisitWindow`, the `revisitWindows` WeakMap content (`explorer/memory.js:50`), restored through an exported `setRevisitWindow`;
  - `review` (`#review`) and `tacticGoal` (`#tacticGoal`);
  - `encounter` (`#encounter`: Set and Map as arrays, `pending`, `lastDecision` with `-Infinity` encoded as `null`);
  - `exclude` (`#exclude`, a Set or `null`) and `seen` (`#seen`, the frozen sightings Map);
  - `hitsLanded` (`#hitsLanded`) and `skills` (`#skills` `SkillSet` state, 7.5);
  - rev. 4 additions: `everSeen` (`#everSeen`), `struck` (`#struck` Map), `hold` (`#hold`), the coin bookkeeping (`#coinKnown` Set, `#coinDue`, `#coinStep`), `dirAskStep`, `leaveDue`, the confidence state (`#cs`, `#csLast`, `#csWhy`, `#capFired` Set) and the mode flags (`#csOn`, `#csAct`, `#caps`, `#holdOn`, which come from the profile, not the snapshot). `memory.directive` rides inside `memory`. `#visibleIds` is recomputed by `#observe()`. Restore must re-run the `check-request-hashes` scenarios from a mid-game snapshot, since any missed field changes request bytes;
  - the shuffle stream's draw count.
- `#remembered` and `#zone` are recomputed by `#observe()` at the start of each turn, so they are not stored. `#lastBodies` and `#skillEvents` are per-turn and are not stored either.
- The brain is rebuilt over a `KnownWorld` on the restored `Game`. It never holds a `Game`.
- **Deadline use:** see section 3. The pre-turn snapshot plus a revocable turn world.

### 7.4 RNG

| Source | Location | Fix |
|---|---|---|
| Global `Math.random` shuffle | `jev.js:52-58`, called from both brains (explorer: tactic, move, approach and skill criteria; adversary `adversary/brain.js:320,357`) | `shuffle(items, rand)` with a per-actor stream injected through opts. |
| `randomSeed()` | `dungeon.js:57` (a private, unexported function); `turn.js` `newGame(seed ?? undefined)` | Server seed from `crypto.randomInt`, stored. |
| `game.patrolRand` | `adversary.js:334` | Draw-count wrapper. |
| per-ghost `patrolRands` | `adversary.js:311-316` | Draw-count wrapper per ghost. |
| `game.skillRand` (block rolls) | `dungeon.js:319-322` | Draw-count wrapper. |
| `game.coinRand` (coin drops) | `dungeon.js` `coinRandom()` | Draw-count wrapper (rev. 4). Every dispel draws exactly once, so the count equals the dispel count. |
| Scripts swapping `Math.random` | 12 scripts, 47 assignments (list in section 2.2), including `lib/duel-harness.mjs` and `request-hashes.mjs` | Switch all of them to injected `rand` in the same change, or keep a thin `seedGlobalRandom()` helper in `scripts/lib` for the ones that only need determinism. Grep `Math.random =` to prove none are left. |

- Keep the synchronous, in-id-order build of adversary request bodies (AGENTS.md "Run") until per-actor streams land and the fog twins are re-proven.
- Shuffle changes alter the option order Jev sees. That is an accepted behaviour change and must be documented.
- `request_sha` is recorded because rebuilding a body and comparing it byte for byte doubles as a fog-regression detector.

### 7.5 Skills

- `Skill` gets `serialize()`/`restore()` for `#cooldownLeft`, `#uses` and `#lastUsedStep`. The numbers (damage, cooldown, effectiveness) come from the loadout plus the profile's skill settings, so they are rebuilt, not stored. `SkillSet` serializes its skills in order. `#chosen` is per-request and is not stored.
- `skills/config.js` `current` is process state set by the profile. Restore asserts that the profile matches.

### 7.6 Versioning

- Every snapshot carries `schema`. `migrations/snapshot/` holds pure `vN → vN+1` functions that `restore` chains.
- A game whose `rules_version` differs on deploy drains and finishes on the old build (default).

## 8. Phased plan

Effort is in engineer-days.

### Phase 0. Foundations and paid-path closure (no change to game rules)

**Goal.** Create the seams, close every unmetered paid path, and prove it with free checks.

**Ownership.** These tasks touch files owned by the world, brain, adversary and shared owners, so they need explicit user authorisation (AGENTS.md rule 9). Run `git status` first.

| # | Task | Files |
|---|---|---|
| 0.1 | Shared network tripwire in `scripts/lib/no-network.mjs`. Import it in every check, including `check-props.mjs` and `check-memory-kit.mjs`, and in `run-testbed.mjs` and `measure-memory.mjs` when `--live` is absent. | `scripts/*` |
| 0.2 | CI pipeline: no secrets, egress to `api.typesafe.ai` blocked, `node --check` on all files, and every `check-*.mjs` plus the dry `measure-memory.mjs` runs (including `--who adversary`). | `.github/workflows/ci.yml` |
| 0.3 | **Close the paid-path bypass.** Remove `askReal` / `ask ?? askReal` (`explorer/brain.js:53,300`) and `jevAsk` / `ask ?? jevAsk` (`adversary/brain.js:79,393`). `ExplorerBrain` throws without `ask`, `stepAdversaries` without `decide`. `jev.js` takes `apiKey` explicitly. Only `server.js` boot wiring (a dev gateway gated by `JD_JEV_LIVE=1`) builds real askers. `run-testbed --live` and `measure-memory --live` go through the same gateway. New `check-paid-paths.mjs`. | both brains, `adversary.js`, `jev.js`, `turn.js`, `server.js`, `scripts/*` |
| 0.4 | `Store` interface plus `FileStore` as the default. `memoryDir`, `dir` and `DATA_DIR` stay as sugar. Replace the writes in `ExplorerBrain#save`, `noteHit`, `noteCaught`, `Run.persist` and `Run.playTurn` (`saveMemories`) with one tick-level call. | `src/store/*`, `turn.js`, `explorer/brain.js`, `explorer/memory.js`, `adversary/memory.js` |
| 0.5 | `MemoryStore`. Convert `check-testbed.mjs`, `run-testbed.mjs` and `measure-memory.mjs` to it, removing their temp-dir handling. | `scripts/*` |
| 0.6 | `jev.js` options: `apiKey`, `policy` (`hedge`, `retries`, `timeoutMs`), external `signal`, abortable backoff, `onAttempt` per HTTP post, returns `{answers, usage}`. Defaults reproduce today's constants exactly. | `jev.js` |
| 0.7 | (Rev. 4: this changes every explorer and ghost request's option order, so `scripts/fixtures/request-hashes.json` and `request-hashes-caps.json` must be regenerated deliberately, in their own commit, with the old-vs-new diff reviewed to show only option order moved.) `shuffle(items, rand)` with per-actor seeded streams and tracked draw counts, injected through `Run`/`ExplorerBrain`/`stepAdversaries` opts. Update every `Math.random` swap (12 scripts, section 2.2) in the same change. | `jev.js`, both brains, `check-adversaries.mjs`, `check-dungeon.mjs` |
| 0.8 | Draw-count wrappers for `game.patrolRand`, the per-ghost `patrolRands` and `game.skillRand`, without changing draw order. | `dungeon.js`, `adversary.js` |
| 0.9 | Serialize/restore: `Game`, `Adversary`, the adversary WeakMap state (`views` including the limited K, `patrolRands`), `AdversaryView`, `Skill`/`SkillSet`, `ExplorerBrain` (bypassing the constructor), `setRevisitWindow`. | `dungeon.js`, `adversary.js`, `adversary-view.js`, `skills/skill*.js`, `explorer/brain.js`, `explorer/memory.js` |
| 0.10 | **Settings profiles.** In `settings.js`: `profileOf(values)` returns `{id, hash, values}`, and `applyProfile(profile)` is applied once at boot. Add a `freeze` mode that rejects later `saveSettings` calls (the cloud default). `Game`, `Run` and the snapshots record the profile hash. The dev `/settings` page keeps working unfrozen. | `src/settings.js`, `server.js`, `turn.js` |
| 0.11 | `KnownWorld.revoke()`: after it, `move` and `useSkill` throw and the reads still work. `ExplorerBrain` accepts its world per turn, or the actor hands it a fresh `KnownWorld` per turn. The static guard still passes. | `known-world.js`, `explorer/brain.js` |
| 0.12 | Doc sync. Fix the stale grace comment (`adversary.js:28-29`). AGENTS.md's "Ordinary tick: with exactly one legal move, the move is forced" should point at the dormant-D4 note. Fix the `check-dungeon --measure` sizes (`check-dungeon.mjs:1950-1958`: 140..150 against `MAX_SIZE = 90`). | `AGENTS.md`, `CONTRACT.md`, `adversary.js`, `check-dungeon.mjs` |

Dropped from rev. 2: the plan/commit split, the constants-drift doc fix (AGENTS.md is now correct), and "remove the dead `forced` branches" (they now carry the D4 skill path; leave them).

**Exit criteria.**

- `node --check` passes, and CI is green with egress blocked.
- All existing checks pass: `check-dungeon`, `check-adversaries`, `check-testbed`, `check-props`, `check-characters`, `check-skills`, `check-memory-kit`, and the dry `measure-memory` including `--who adversary --accept`. The twin suites change only to inject `rand`. The request-size asserts are unchanged.
- The 200-seed determinism check passes (`check-dungeon.mjs:134-135`). The 30-seed spawn-position check in `check-characters.mjs` still passes.
- `check-paid-paths.mjs` passes.
- New `check-persistence.mjs` passes, **for both settings modes** (defaults; `adversaryCharacters` + `limitedMap` on) and for a testbed arena:
  - `serialize → JSON → restore → serialize` is byte-equal, including `litOutside` at a map edge, a limited view with faded and evicted cells, a stunned ghost, a skill mid-cooldown, a raised block, and a game after a dispel.
  - N stubbed ticks on the original and the restored copy give equal event streams and request bytes.
  - A restored brain makes no extra `start` decision.
- New revocation test: a stub `ask` that resolves *after* `revoke()` leaves the `Game` (`pos`, `steps`, `adversaries`, `strikes`) unchanged.

**Effort.** About 28-35 days. The long pole is 0.9 (7-9 days, up from 4-6 because of skills, characters and the limited view).

**Risks.**

- The `check-props` single-import limit on `dungeon.js`.
- A missed private field. Round-trip tests in both settings modes are the safety net.
- Concurrent edits by other sessions.
- Making `ask`/`decide` required breaks every script that relied on the default. That is intended.

### Phase 1. Persistence, multi-game hosting and the cost guard (private games)

**Goal.** Many concurrent, durable, fog-safe private games, still single-user and not internet-facing, with spend bounded before the server drives any tick.

| # | Task | Files |
|---|---|---|
| 1.1 | **Cost guard (first task).** `JD_JEV_LIVE` kill switch, `JD_DAILY_POST_CAP` (a Postgres counter shared by every worker), per-game `max_ticks` and `max_posts`, pause-on-cap with `pause_reason`, autoplay off by default. | `jev-gateway.js` (minimal), `config.js` |
| 1.2 | **Profile workers.** A small supervisor (reusing `hub.js`'s spawn and proxy code, but bound to localhost and without the open management API) runs one `server.js` worker per active profile. A game is routed to its profile's worker. One default profile runs from the start. | `src/runtime/registry.js`, supervisor |
| 1.3 | `GameRegistry` and `GameActor` inside each worker. They replace `run` and `busy`. The actor's tick loop is the per-game mutex. Every actor tick is wrapped in try/catch, so one game's exception pauses only that game (`pause_reason = 'error'`). | `registry.js`, `actor.js`, `server.js` |
| 1.4 | Postgres schema (6.2 profiles, 6.3-6.5), migrations, and `PgStore` with `loadGame` and `saveTick` (one transaction, `expectTick` fence). | `src/store/pg-store.js` |
| 1.5 | `TickScheduler`. Per tick: `clearTickState`; snapshot the brain; run `takeTurn` over a fresh turn world with an abort-aware `ask`, raced against `D`; on a miss, abort, revoke, restore and use `fallbackMove`; then `stepAdversaries`, persist, publish. `tickMs` is a floor; overruns are skipped. Record the move source. | `scheduler.js` |
| 1.6 | Fog-safe `fallbackMove(world)` over `KnownWorld` only. Order: the chest if it is adjacent on a known path; else away from the nearest visible adversary (`knownDistances`); else toward the nearest frontier, avoiding `avoidZone` cells; else `stay`. **It never uses a skill**, so no fallback can strike. It never returns `legal[0]` blindly. | `explorer/fallback.js` |
| 1.7 | Adversary deadline: the same race inside `decide`. A late or failed answer already falls back to `codeHuntDir` (`stepAdversaries`, `res.error`). On a miss, `skill` is `'none'`, so a fallback ghost never strikes. This is a small edit to adversary code. | `adversary/brain.js`, `adversary.js` |
| 1.8 | Error classification: `transient` (timeout, 429, 529, network), `auth` (401/403), `budget`. Only `transient` takes the fallback. `auth` and `budget` pause the game, and `auth` marks the key `failing`. Today a Jev error rejects the whole turn and surfaces as a 502 (`server.js` `/api/step`). | `jev-gateway.js`, `scheduler.js` |
| 1.9 | Degraded-player rule: after N (default 5) consecutive transient fallbacks, run code-only until a probe succeeds. | `scheduler.js` |
| 1.10 | `ViewProjector.forPlayer(game, par, since)` and SSE (`GET /v1/games/:id/events`). Every current view field gets a ruling (section 10). Remove `tiles`, `treasure`, `seed`, `explored_pct` and the hidden adversaries from the default view. Memory leaves `/api/state`. Add a `render_salt` field for the renderer (section 10). | `view-projector.js`, `sse-hub.js`, `dungeon.js`, `turn.js`, `public/app.js` |
| 1.11 | Pause and idle rule: a game with no viewers and no autoplay flag stops ticking and snapshots. | `actor.js` |
| 1.12 | Boot and shutdown: resume running `autoplay` games; on SIGTERM, stop ticks, snapshot everything and close. `/healthz`, `/readyz`. | `server.js` |
| 1.13 | Dev legacy shim: `/api/state`, `/api/new`, `/api/step` and the hub keep working under `NODE_ENV=development` only. | `server.js` |
| 1.14 | Retire `memory.md` and `adversaries.json` from the write path (render on demand). `store` is required outside tests. Delete the `MEMORY_DIR`/`DIR` defaults (`explorer/brain.js:45`, `turn.js:12`). | `explorer/brain.js`, `turn.js` |

**Exit criteria.** Free checks green, plus:

- `check-runtime.mjs`:
  - **Isolation:** two games with the **same** profile, interleaved in one worker, match their solo runs. Starting a game with a different profile in a worker is refused.
  - With a store injected, nothing is written under the repo root.
  - **Deadline:** a never-resolving stub `ask` yields a fallback within `D + ε`, restores the brain, keeps `pending`, and does not stall another game. A late resolve leaves the live `Game` and brain unchanged, including a late answer that picked `sword_strike_*`.
  - Crash and restore resumes from the last committed tick, without a `start` decision.
  - **Cost guard:** with `JD_JEV_LIVE` unset there are no gateway posts. The daily cap pauses every game across two workers. A per-game cap pauses that game.
  - **Errors:** `auth` pauses the game. One actor's exception leaves others ticking.
  - Overrun skipping, pause and resume.
- `check-views.mjs`: for every tick of scripted games (default profile and characters-plus-limited profile), the serialized view has no hidden adversary coordinate, no hidden ghost strike, no unlit treasure, no unknown tile, no `seed`, no hidden prop or decor, and no ghost `hp`/`character`/`facing`/`brain`. Views must be byte-identical when hidden state (tiles, props, decor, treasure, hidden ghosts and their hp, stun and skills) is scrambled.
- Twin tests cover `fallbackMove`, and it passes the static guard.
- Staging double-write (`FileStore` plus `PgStore`) shows identical memory JSON each tick.
- The staging latency run records p50 and p95 for explorer and ghost calls and fixes `D` and `tickMs`.

**Effort.** About 34-42 days.

**Dependencies.** Phase 0.

**Risks.**

- The renderer uses full `tiles`, `treasure`, `props`, `seed` and `explored_pct`. This is a UI-agent task and needs a visual check.
- Process-per-profile memory cost. Measure it, and cap the number of active profiles.
- Event-loop CPU under load: limited-map views scan line of sight per ghost per tick.

### Phase 2. Players, agents, auth, BYOK, quotas, and internet hardening

**Goal.** Safe on the internet, with real accounts, per-player cost control and transport security.

| # | Task | Files |
|---|---|---|
| 2.1 | ID library, handle rules and uniqueness. | `src/ids.js` |
| 2.2 | OIDC auth, server-side sessions (HttpOnly, Secure, SameSite=Lax), CSRF checks, roles (`owner`, `player`, `spectator`, `admin`). Every `:id` route checks membership. | `server.js`, `src/auth/*` |
| 2.3 | Transport hardening: HTTPS termination, `trust proxy`, security headers, closed CORS. Today `send()` sets only `Content-Type`. The `STATIC` whitelist stays (rule 5). | `server.js` |
| 2.4 | **Lock down the dev surfaces.** `/api/settings` (write), the hub's `/api/instances` and the `/settings` page are absent from production builds. Profile creation is an admin action with an audit row. The supervisor binds localhost only. | `server.js`, `hub.js`, supervisor |
| 2.5 | `JevGateway` (full): per-tenant key, one usage row per HTTP post, a global in-flight semaphore (`maxInflight` 32; queue wait counts against the deadline), budgets, a breaker on 429/529 storms, a token bucket. Default hedge 1, retries 1. Caps come from the profile (6.5). | `jev-gateway.js` |
| 2.6 | Encrypted BYOK store. Decrypt only in the gateway. Redact `Authorization`, `key` and `apiKey` from logs and errors. | `api_keys`, gateway |
| 2.7 | Quotas and per-game budgets. A cap hit pauses with a clear reason and never falls back silently. | `quotas`, `scheduler.js` |
| 2.8 | `AgentProfile` presets wired into `new ExplorerBrain(world, { ask, store, profile, skills })`. Presets map to numbers only (6.2). A check proves that a non-default preset changes request bytes only where the numbers appear, and that every preset stays inside the request-size asserts. | `src/agents/profile.js`, `explorer/brain.js` |
| 2.9 | Platform-key free tier. | gateway |
| 2.10 | Abuse limits: rate limits on creation and join; per-user ceilings on tick rate, games and budget; max ticks; idle timeout; 413 above 20 kB (`readBody`). **Client testbed configs are disabled in production** unless the user has a `testbed` entitlement. `normalizeConfig` bounds size (≤ 60×60), ghosts (≤ 8) and `ghostHp`, but a testbed body also sets characters and skills. | `server.js` |
| 2.11 | API surface (section 9) with the JSON error contract `{error:{code,message}}`. Fix the swallowed `busy.catch(() => {})` in `startNewGame`. | `server.js` |
| 2.12 | Spectator view (delayed, fogged) and a leaderboard (steps to chest, lives lost, ghosts dispelled, Jev cost). | `view-projector.js` |
| 2.13 | **Parallel-seed races.** One `Game` per participant on one shared seed **and one shared profile**. Race seeds are server-secret, `crypto`-generated, single-use, and withheld until the race ends. | `registry.js`, lobby routes |
| 2.14 | Prompt-injection controls (section 12). | `profile.js`, tests |
| 2.15 | Audit log. | `audit_log` |

**Exit criteria.** Free checks green, plus:

- Authz matrix per route and role.
- Transport headers and cookies. Cross-origin writes are rejected.
- **No dev surface in production:** `POST /api/settings`, `/api/instances`, `/api/step` and `/settings` return 404.
- Gateway test against a fake server: hedge losers are counted, a 429 storm opens the breaker, `auth` pauses the game and marks the key, and budget exhaustion pauses without further posts.
- Key canary: the key never appears in logs, errors, views or snapshots.
- Injection test: scrambling every player-controlled string leaves request bytes identical (v1 personas send no text).
- Race test: the seed appears nowhere before the race ends, and both participants' games record the same profile hash.

**Effort.** About 40-46 days.

**Risks.** Key leakage through logs, cap UX, auth scope creep, and hedge billing (open question 4).

### Phase 3. Cloud deployment, ops and scale readiness

| # | Task |
|---|---|
| 3.1 | Multi-stage Dockerfile on `node:22-slim`, non-root. Add `"engines": {"node": ">=20.12"}` and a lockfile. |
| 3.2 | `src/config.js` validated at boot. Environments: `dev` (stub gateway by default; hub available), `staging` (real Jev, low-budget key), `prod`. A test-mode gateway without a stub throws. |
| 3.3 | A protected manual workflow for live runs with a hard budget cap. It covers the staging latency run and any `--live` measurement. |
| 3.4 | Observability. Structured JSON logs (`ts, level, gameId, profileId, tick, actor, tenant, event`). Metrics: `jev_calls_total`, `jev_http_posts_total`, `jev_request_bytes`, `jev_latency_seconds`, `tick_duration_seconds`, `tick_overrun_total`, `fallback_moves_total`, `cap_fallback_total`, `players_degraded`, `breaker_state`, `event_loop_lag_seconds`, `store_write_seconds`, `sse_clients`, `workers_active`. Alerts: fallback rate > 20% for 5 min, breaker open, loop lag > 200 ms, daily budget at 80%, lease flapping. |
| 3.5 | Retention jobs (section 11). |
| 3.6 | Static assets behind a CDN with cache headers (keep `STATIC`). |
| 3.7 | CPU profiling. If it bites, use a `worker_threads` pool for `takeTurn`, or more profile workers. |
| 3.8 | Leases and fencing (`owner_node`, `lease_expires_at`, `lease_epoch`), sticky routing by `gameId` within its profile. **Only on measured need.** |
| 3.9 | Legacy cutover: update AGENTS.md rules 2 and 7 and CONTRACT.md in the same PR. |

**Exit criteria.** Runtime checks in CI with no network or key. Kill and restart resumes from the last snapshot. Graceful drain works. With leases, a zombie owner's write is rejected.

**Effort.** About 12-18 days. **Dependencies.** Phase 2. **Risks.** Fencing mistakes, premature multi-process work.

### Phase 4. Shared-world multiplayer (race rules)

**Goal.** Several explorers in one dungeon, competitive, with no mutual visibility at first.

Rev. 4 note: the `cleared` win (the explorer dispels the last ghost) needs a shared-world rule. Recommended: the dispelling explorer wins, so `winBy: 'cleared'` is per participant (open question 5).

**Decide first:** open question 5 (win rule), open question 6 (ghost billing) and open question 7 (cross-player combat).

| # | Task | Files |
|---|---|---|
| 4.1 | `ExplorerState` and a `players` Map inside `Game`, holding `pos, steps, visits, light, knownCount, knownFloor, litOutside, health, maxHealth, graceTicks, trail, won/lost/caughtBy, facing, block, skillRand`. Keep delegating single-player getters, so existing checks stay green at each step. `twin(overrides)` copies the Map. Everything stays in `dungeon.js` (single-import rule). `strikes` stays world-level with an `on: playerId`. Snapshot schema v2. Light is never merged. | `dungeon.js` |
| 4.2 | `KnownWorld(game, playerId)`. All reads delegate to that player's state. | `known-world.js` |
| 4.3 | Static guard: ban `players.` / `.players` in explorer files except `known-world.js`, with a self-test fixture. | `check-dungeon.mjs` section 0 |
| 4.4 | **Ordered apply.** Each explorer's `takeTurn` mutates the world at its tail (`#useSkill`, `world.move`). In a shared game, the turn world's mutators become *intents*: they resolve at that participant's slot, in slot order, once every participant has submitted (or fallen back). The brain code is unchanged, and its awaits already allow this. | `known-world.js`, `scheduler.js` |
| 4.5 | **Multi-target adversaries.** Sensing (`seesExplorer`, `startsChase`, `tracksExplorer`) takes an explorer. `chooseTarget` has hysteresis and breaks ties by player id. `targetId` and per-target `lastSeen`/sightings stay private in the hunt. `AdversaryView` exposes only the target's position, and only in sight. Pack alerts carry the target. `alertNearby` may join a packmate to a different explorer's hunt only when that packmate sees nothing. | `adversary.js`, `adversary/brain.js`, `adversary/perception.js`, `adversary-view.js` |
| 4.6 | **Combat per explorer.** Bump: `bumpCheck` and the knockback cell choice avoid **every** living explorer's cell and trail cell. Strike: `strikeWith`/`resolveAttack` hit whichever explorer stands in the strike cells (target first, then by player id); block and grace are per explorer; the `hit` latch becomes `Set<playerId>`. `hit`, `blocked` and `caught` gain `player`. **Early returns:** (a) the entry `won \|\| lost` return becomes "no explorer active"; (b) the lethal-strike `return { events, turns }` inside the loop becomes "mark that explorer out and continue". `Game.damage` is per explorer (it is a no-op once won or lost today). Keep rule 6: a touch is a bump, only strikes take lives. | `adversary.js`, `skills/resolve.js`, `dungeon.js` |
| 4.7 | **Explorer strikes on shared ghosts.** A dispel by A removes the ghost for everyone. B's brain keeps its frozen sighting until the seen-empty rule clears it, because B did not see the dispel (fog). Stun and knockback from A's strike apply world-wide. Ruled by open question 7. | `resolve.js`, `explorer/brain.js` |
| 4.8 | Race ruleset: the first explorer on the chest ends the game, ties broken by slot. `Game.won` and `Game.lost` become derived. | `dungeon.js`, `turn.js` |
| 4.9 | Multi-start spawn as a **separate post-pass on its own stream**. Spawn and character-assignment draw order stay unchanged (rule 8). Revisit the ghost-count formula for several explorers. | `adversary.js` |
| 4.10 | Per-game ghost-call cap in `decide`. Capped ghosts use `codeHuntDir` and never strike. Billing comes from open question 6. | gateway |

**Exit criteria.**

- Existing checks green with the single-player getters.
- New twins:
  - scrambling B's position, health, trail, light, memory, mind, facing and block leaves A's request bytes identical;
  - B's moves never change A's `light`, `visits` or `trail`;
  - a ghost body differs only by its chosen target.
- Combat tests:
  - one ghost against two players, with per-player grace, block and latch;
  - knockback never lands on any explorer;
  - target choice is deterministic;
  - **a lethal strike on A mid-tick still lets the remaining ghosts step, bump-check and strike B**;
  - A's dispel leaves B's remembered sighting until it is seen empty.
- Ordered apply: two participants submitting in reverse completion order produce the same world as slot order.
- The per-viewer leak test passes.

**Effort.** About 35-55 days. 4.5 and 4.6 together are the largest behaviour change.

**Dependencies.** Phase 2, the snapshot v2 migration, and open questions 5-7.

**Risks.** Balance (pack alert, team sight, characters), spawn fairness, and the many single-explorer reads in `adversary.js`, `adversary-view.js` and `resolve.js`.

### Phase 5. Later options

- Opt-in `KnownWorld.visibleExplorers()` returning `{id, pos, distance}` only, inside `SIGHT_RANGE` plus LOS. Sentence-only `others` in `situation()`, never in `tacticFeasibility` or skill options. It lands with its twin tests.
- Co-op ruleset (shared findings, no friendly strikes). Needs its own leak analysis.
- Per-game `rules` objects replacing process profiles (section 3), if custom per-game settings become a product need.
- Free-text personas, once open question 3 sets a byte budget.
- The ghost `mood` layer and `wait` skill (PLAN-adversary-memory.md), if built, would need serialize coverage.
- An optional `rng` state-object refactor. Replays (start snapshot, moves and recorded answers, stub-driven), cold storage, rollups.

## 9. API surface

```
POST   /v1/auth/session                     create session (OIDC callback)
POST   /v1/games                            {spec, profileId?} -> {id}   rate-limited; default profile if omitted
GET    /v1/games/:id                        summary (member only)
POST   /v1/games/:id/players                {agentVersionId, keyId} -> {parId}   join
DELETE /v1/games/:id/players/:parId         leave
POST   /v1/games/:id/control                {action: start|pause|resume}
GET    /v1/games/:id/events                 SSE: view | tick | notice, id = tick number
GET    /v1/games/:id/players/:parId/memory  owner or admin only
GET    /v1/profiles                         list (values readable; create is admin-only)
POST   /v1/keys, GET /v1/keys               returns {id,label,last4,status} only
POST   /v1/agents, GET /v1/agents ...       versioned
GET    /v1/admin/...                        omniscient view, call log, usage, profile create
```

- Everything is under `/v1`. SSE payloads carry `schema`, and SSE event ids are the tick number.
- The browser sends no step requests. Its controls are pause, resume and speed.
- The `STATIC` whitelist is kept (rule 5). Pages keep relative URLs, so they work under a prefix.

## 10. Per-viewer view rules

`Game.publicView()` and `Run.view()` are the leak surface today. **Every field gets a ruling.**

| Field | Where | Ruling |
|---|---|---|
| `tiles` | `publicView` | Removed. Admin Reveal only. |
| `treasure` | `publicView` | Only once lit (`seenTreasure()` semantics), else `null`. |
| `seed` | `publicView` | Removed. **The renderer derives wall and big-decor heights from it** (`app.js:316,325`). Send `render_salt = HMAC(server secret, game id)` instead. Heights stay stable per game and reveal nothing about the map. |
| `start` | `publicView` | Own start only. |
| `width`, `height` | `publicView` | Padded bounding box of the known region plus a margin. The true size is acceptable for the owner of a private game and rejected in competitive games (open question 10). |
| `props`, `decor` | `publicView` | Projected to lit cells. Solid props and forge footprints outline the layout. |
| `explored_pct` | `publicView` (`exploredPct()`) | Dropped: `knownFloor / floorCount` reveals map size. Replaced by a known-floor count. UI reads at `app.js:1510,1940`. |
| `light` (full grid), `visits`, `trail` | `publicView` | Own state only. Full grid on connect or resume, then deltas. |
| own `pos`, `steps`, `won`, `lost`, `health`, `max_health`, `facing` | `publicView` | Sent. |
| `strikes` | `publicView` | The explorer's own strikes, plus ghost strikes whose attacker is visible or whose cells include the explorer's cell. A strike by a hidden ghost would otherwise place it. |
| `block` | `Run.view()` | Own state, sent. |
| `coins`, `coin_piles` (rev. 4) | `Run.view()` | Own purse sent. Piles only on lit cells (as `seenCoins()`); unlit piles are hidden state. |
| `won_by` (rev. 4) | `Run.view()` | Sent. |
| `directive` (rev. 4) | `Run.view()`, `/api/step` | Owner only (player-written text). |
| `confidence` (`value`, `band`, `capability`, `history`) (rev. 4) | `turn` | Owner only, with the decision probabilities. |
| `grace_ticks`, `invulnerable`, `over` | `Run.view()` | Sent. |
| `testbed` | `Run.view()` | Sent (a property of the owner's own game). |
| adversaries `{id, pos, mode, visible}` | `Run.view()` | Only those `seesExplorer` now, with `{id, pos, mode}`. |
| adversaries `brain`, `character`, `facing`, `hp`, `max_hp` | `Run.view()` | **Admin Reveal only.** These are sent to every client today and hidden only by the UI. The explorer's own `#hitsLanded` tally ("you have hit a1 once") may be shown instead of `hp`. |
| memory | `/api/state` | Owner or admin only. |

Further rules:

- A full lit grid is sent only on connect or resume. It never contains an unlit treasure, hidden adversaries, `seed`, or another player's state.
- Decision probabilities and options (`move_decision`, `decision`, `skill_decision`) are visible to the owner only.
- Spectators of competitive games get a fogged view delayed N ticks, with no memory.
- `check-views.mjs` scrambles hidden tiles, props, decor, treasure, hidden adversaries and their hp, stun and skills, and requires byte-identical views.

## 11. Retention

| Data | Hot | Delete |
|---|---|---|
| `game_state` | while running or paused | 30 d after finish |
| `game_snapshots` | 7 d | 90 d free, 1 y paid. Keep first, last and every 25th. |
| `events` | 30 d | 1 y |
| `jev_calls` | 14 d full | null `request_body` and `answers` unless opted in; metadata 13 months |
| `settings_profiles` | while referenced | never while a game references it |
| `api_keys` | active | revoked: purge ciphertext after 30 d, keep `fingerprint` and `last4` |
| accounts and players | | erase email, handle and display name within 30 d of deletion; keep ledger rows without PII |

A nightly job prunes by these windows and never touches running or paused games.

## 12. Security and prompt-injection rules

- **The player directive is an existing exception (rev. 4).** `POST /api/inject` (PLAN-inject I1-I4) already puts one sanitised, length-capped (`injectMaxChars` 140), control-stripped string into the explorer's request (`state.directive`, the first priority line, one rules sentence). It is the "one bounded field" this section anticipates, and it is already built, so open question 3's byte budget is partly spent (about 250 / 670 B left). Cloud rules: private games, owner only, behind the `injectEnabled` profile value, with the cooldown and step limits; **disabled in races and shared worlds** until question 18 is answered; never reaches a ghost's state; an audit row per directive. `check-inject.mjs` already proves the bytes change only where the directive appears.
- **v1 otherwise: no player-controlled text reaches Jev.** Personas are preset ids that map to numbers. Agent names, handles and display names never enter any `state`.
- If free text is ever allowed (Phase 5), it goes into exactly one new, bounded, control-stripped field, with a byte budget agreed under open question 3 and a twin test proving it changes bytes only there.
- Never place player-controlled text in `rules()`, `questions`, option criteria or anything that can name a move or skill key. Option keys (`up`, `sword_strike_left`, tactic ids) stay code-generated.
- Never put another player's data in any player's `state` or in a ghost's `state`. Ghost `character` words come from `character.js` presets, never from players.
- Jev's output is a typed Choice or Noul, so injected text can at most bias a choice. `pickSkill` still needs `SKILL_MIN`.
- Any new memory field that reaches Jev must be fog-safe, fit `LIMITS` (`explorer/memory.js:30-42`), and keep the request-size asserts green.
- Settings changes are an admin action in production. A rules change is a spend change: speed, ghost count, `alertSteps` and `teamSight` all move the number of ghost calls per tick.
- No route accepts a bare `gameId` without a session.
- Third-party disclosure: memory, situation text and ghost requests go to TypeSafe.

## 13. What NOT to do

- Do not add Redis in v1, or move to multiple nodes before a measured need.
- Do not let any code path construct a real Jev asker outside the gateway. Do not read `JEV_API_KEY` outside it.
- Do not run server-side autoplay without the kill switch, the daily post cap and per-game limits.
- Do not hit `/api/step`, press Start, step a hub instance, or pass `--live` to test anything. Inject stubs and install the tripwire in every script.
- Do not JSON-clone, spread or `structuredClone` a `Game`, `Adversary`, `AdversaryView` or `Skill`. Do not add public fields to `Adversary`.
- Do not add or reorder `rng()` calls in `generateDungeon`, `spawnAdversaries` or `assignCharacters`. Change `SPAWN_STEPS` (`dungeon.js:28`) and `MIN_SPAWN_STEPS` together.
- Do not add any relative import to `dungeon.js` beyond the `placeProps` line.
- Do not hold a `Game` in explorer code. Do not import `store/` or `runtime/` from explorer files.
- Do not run two games with different settings in one process, and do not change a running game's settings. Use a new profile instead.
- Do not let an abandoned (deadline-missed) turn reach the live world. Always revoke its `KnownWorld`.
- Do not let a fallback move use a skill.
- Do not persist or send a cross-player merged light map.
- Do not rename `Run` or use `run_` as a DB prefix.
- Do not let persona or any player text reach `rules()`, `questions` or hidden state. Do not spend the request-size headroom without recording it in AGENTS.md.
- Do not regenerate a dungeon from its seed after a generator or profile change. Pin it or fail loudly.
- Do not silently fall back to code when a budget is hit. Pause and say why.
- Do not split `takeTurn` into plan/commit.
- Do not make a touch hurt again (rule 6), including in the multi-explorer code.
- Do not expose `hub.js`, `/api/settings` or `/api/instances` publicly, or the service at all before Phase 2 is complete.
- Do not hand-edit runtime output (rule 7). Do not commit or edit other sessions' uncommitted work.

## 14. Open questions for the user

1. **Rules scope.** Process-per-profile in Phase 1 (recommended), or invest now in per-game `rules` threaded through every module so one process can host games with different settings?
2. **Cloud default profile.** Ship with `adversaryCharacters` and `limitedMap` off (recommended until a live run validates them), and with what platform ceiling on `maxAdversaries` (the settings page allows 24)?
3. **Persona text budget.** Keep v1 personas numeric-only (recommended), or approve a byte budget (for example 120 B) and say what gets shortened to pay for it?
4. **Hedge billing.** Does TypeSafe bill an aborted hedge copy, and does it support per-key quotas?
5. **Shared-world win rule.** Race (recommended first) or co-op? Needed before Phase 4.
6. **Ghost billing in shared worlds.** Target pays with per-game caps, or the owner or a pool pays?
7. **Cross-player combat.** May A's sword dispel or stun a ghost hunting B? May explorers ever strike each other (recommended: no)?
8. **Key model.** BYOK-only, or platform credits with a free allowance, and how large?
9. **Deploy policy for rules changes.** Drain on a `rules_version` change (default), or run old builds side by side?
10. **Viewer width and height.** Is a padded bounding box acceptable for private games, and must competitive games hide the true size?
11. **The hub's future.** Keep `hub.js` as a dev and testing tool only (recommended), with the supervisor in 1.2 as a new localhost-only component? Or grow the hub into the cloud supervisor?
12. **File ownership.** Phases 0 and 1 touch files owned by the world, brain, adversary, UI and shared owners. Do you authorise the cross-role edits (rule 9)?
13. **Deadline numbers.** After the latency run, which `tickMs` floor and deadline `D`?
14. **Platform spend ceiling.** What daily post cap should `JD_DAILY_POST_CAP` start at, and who may flip `JD_JEV_LIVE`?
15. **Staging latency run.** Do you authorise one budget-capped live run to measure Jev p50/p95? It is the only paid step this plan needs before Phase 1 exits.
16. **Spectators and Reveal.** Confirm that spectators never see agent thoughts and that Reveal is admin-only (owner-only in non-competitive games).
17. **Dependency policy.** Confirm that `pg` plus a migration tool ends the zero-dependency convention.
18. **Player directive in the cloud (new).** Keep it for private games only (recommended), allow it everywhere, or switch it off in the cloud profile? It is player free text in Jev's request and a cheating channel in a race.

## 15. Phase summary

| Phase | Theme | Effort | Depends on | Gate |
|---|---|---|---|---|
| 0 | Foundations, paid-path closure, settings profiles, revocable world, no-egress CI | 28-35 d | none | all existing checks, `check-persistence.mjs` (both settings modes), `check-paid-paths.mjs`, revocation test |
| 1 | Persistence, profile workers, private multi-game, cost guard | 34-42 d | 0 | `check-runtime.mjs`, `check-views.mjs`, latency numbers |
| 2 | Auth, agents, BYOK, quotas, hardening, dev-surface lockdown, races | 40-46 d | 1 | authz, transport, dev-surface 404s, gateway, key-canary, injection, race tests |
| 3 | Cloud deploy, ops, scale readiness | 12-18 d | 2 | CI without network, restore and drain tests |
| 4 | Shared-world race | 35-55 d | 2, questions 5-7 | multi-explorer twins, combat and ordered-apply tests |
| 5 | Visibility, co-op, per-game rules, personas, replays | open | 4 | own design reviews |

Phases 0-3 change **no adversary targeting or balance logic**. They do make small adversary-code edits: the deadline race, injected `rand`, required `decide`, serialize/restore and the WeakMap snapshot helpers. They also change Jev's option order. Capped ghosts taking the code fallback is accepted drift, surfaced as `cap_fallback`. Phase 4 is the only phase that changes targeting and combat.

## 16. Caveats

- Line numbers drift. Prefer the symbol names given beside them. **Rev. 4 sweep:** the citations for `app.js`, `explorer/brain.js` (53, 300), `check-dungeon.mjs` and the `Math.random` swaps were re-checked against 92fc01e and updated. Other citations were spot-checked by symbol and still resolve (`SPAWN_STEPS`, `lightAround`, `skillRandom`, `patrolRands`, `views`, `homeDists`, `byId`, `revisitWindows`, `LIMITS`, `MEMORY_ON`, `KEEP_HUNTING_MIN`, `codeHuntDir`, `saveMemory`, `saveMemories`, `loadEnvFile`, hub `listen`), but their line numbers have moved.
- This revision re-read:
  - `server.js` and `src/jev.js`, `src/turn.js`, `src/settings.js` (all);
  - `dungeon.js:6-15,28,46,57,163,209,268-295,300-340,381-408`;
  - `adversary.js:25-41,62-70,81-112,236-253,278,286,311-334,545-641`;
  - `adversary/brain.js:20-33,79,291-428`;
  - `explorer/brain.js:32-48,59,111,161-205,236,326-512`;
  - `explorer/memory.js:27,30-50,289-290`;
  - `adversary/memory.js:26,222`;
  - `adversary-view.js:1-60`;
  - `skills/skill.js`, `skills/skill-set.js` (private fields);
  - `character.js:120-123`;
  - `hub.js:1-40,90-106,177-234`;
  - `app.js:285-310,577-579,1036,1066,1256,1602-1610`;
  - `check-dungeon.mjs:134-135,715,1950-1958`;
  - `check-adversaries.mjs:6,607,1161,1221`;
  - the tripwire grep over `scripts/*.mjs`.

  Other citations come from AGENTS.md.
- The CPU, billing, latency and per-process memory claims are inferences. Each has a measurement step.

## Changes since rev. 3 (sync to commit 92fc01e)

Code facts re-verified against HEAD: `askReal`/`jevAsk` defaults, `HEDGE`/`RETRIES`/`TIMEOUT_MS`, the hub's all-interface listen (`hub.js:234`), the single `placeProps` import in `dungeon.js`, and the 9500 / 10500 asserts are all unchanged. Line numbers throughout have drifted; use symbol names.

- **Four moods.** `SENTIMENTS` has `wary`, `steady`, `greedy`, `bold` and memory validation rejects any other id. `AgentConfig` and its clamps now use these (6.2).
- **Player directive** (`/api/inject`, `Run.submitDirective`, `memory.directive`, `inject*` settings). Player text reaches Jev. Section 12 and open question 18 added; the API table gains a directive route.
- **Coins, cleared win, health bars.** New `Game` state (`coinPiles`, `coins`, `coinRand`, `winBy`), new view fields and a new RNG stream; serialize, views and the shared-world win rule updated.
- **Confidence model and caps, engage hold.** Brain state (`#cs*`, `#caps`, `#hold`, `#struck`, `#everSeen`) enters the snapshot. `server.js` derives the brain's `confidence` option from `confidenceCaps` / `confidenceModel` / `confidenceMeter`, so these settings belong in the profile hash.
- **Request headroom** is about 250 / 670 B, not about 100 B.
- **Request-hash fixtures** are a new determinism guard that Phase 0.7 will deliberately break.
- **Thought-bubble variants** use `Math.random` only in `public/app.js` (display only), so they are outside the RNG scope.
- **Tripwire coverage** needs re-auditing (section 2.2).
- **`Math.random` swaps** are in 12 scripts (47 assignments), not 4: task 0.7, the RNG table and the Phase 0 exit criteria now cover all of them.
- **Citations** re-checked by symbol; `app.js`, `explorer/brain.js` and `check-dungeon.mjs` line numbers updated (section 16).

## Changes since rev. 2

**Structural**

- **Settings profiles** (sections 1 and 3, tasks 0.10 and 1.2, table 6.2, open question 1). Tunables are process-wide `export let` state, so Phase 1 hosts one worker per immutable profile. `games.constants` became `profile_id`.
- **Persona** (sections 3, 6.2 and 12, task 2.8, open question 3). `memory.objective` and `profile_note` are gone, and the request-size headroom is about 100 B, so v1 personas are numeric presets.
- **Damage model** (Phase 4.6). A touch is a bump, and only strikes take lives. `touchCheck` is replaced by `bumpCheck`/`strikeWith`/`resolveAttack`. There are now two early-return sites. "Keep touch is damage" is reversed.
- **Late-answer mutation** (sections 2.2 and 3, tasks 0.11 and 1.5). An abandoned `takeTurn` still calls `world.useSkill`/`world.move`. Fixed with an unconditionally rejecting `ask` plus a revocable `KnownWorld`, and a test.
- **Ordered apply in shared worlds** (task 4.4). Parallel `takeTurn`s mutate the world at their tails, so a shared game gates those mutations into slot order.

**State and determinism**

- Serialize grew. It now covers skills (`Skill` cooldowns, `Game.facing/block/strikes/skillRand`), ghost `hp/stun/facing/character/home`, the brain's `#seen/#exclude/#hitsLanded/#skills`, and the `adversary.js` WeakMaps (`views` with the limited K, `patrolRands`). Effort for 0.9 went up.
- The RNG table adds per-ghost patrol streams, `skillRand` and the character-assignment stream. Twin swaps are re-cited.

**Cost and exposure**

- The cap formula now uses the profile's `maxAdversaries` (up to 24 on the settings page), with skill-only ghost requests and no calls from stunned or dispelled ghosts.
- New exposure facts: the hub binds every interface, and `/api/instances` and `/api/settings` are unauthenticated. Task 2.4 locks them down.
- The daily cap becomes a Postgres counter, because there are several workers.

**Views**

- New ruling rows for `facing`, `strikes`, `block`, `over`, `testbed`, and the per-ghost `character`, `facing`, `hp` and `max_hp`.
- `render_salt` replaces `seed` for the renderer's height hash.

**Resolved or dropped**

- The constants-drift corrections and their open question (AGENTS.md now matches the code).
- "Remove the dead `forced` branches" (they now carry the D4 skill path).
- The `a10` note stays a check only.
- Event types now include `bump`, `strike`, `struck`, `dispelled`, `blocked` and `alerted`.
- The tripwire gap list is updated: `check-props`, `check-memory-kit`, dry `run-testbed`.
