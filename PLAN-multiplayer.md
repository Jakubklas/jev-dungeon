# Jev Dungeon: Cloud and Multiplayer Implementation Plan (rev. 2)

## 1. Bottom line

**Build in this order: refactor and close the paid-path leaks first, then durable multi-game hosting with a cost guard, then accounts, keys and the internet-facing hardening, then cloud ops, then a shared world.**

- **Spend safety comes first.** Today the browser loop is the only thing that spends money, and closing the tab stops it (`public/app.js:1262-1305`, one `POST /api/step` per step at `server.js:101-112`). Moving ticking to the server removes that brake. So the kill switch, a platform-wide daily post cap, per-game limits and pause-on-cap ship in the same phase as server-side ticking (Phase 1). Autoplay stays off by default until Phase 2 budgets exist.
- **One paid path only.** `ask` and `decide` become required in both brains, and `jev.js` takes its key as a parameter. Only the `JevGateway` builds real askers. Today both brains default to the real Jev (`src/characters/explorer/brain.js:34,143`; `src/characters/adversary/brain.js:44,234`), and `jev.js` reads the global env key per request (`src/jev.js:17`). One missed injection would bill the platform key and skip metering.
- **Multiplayer model.** Private games first, one `Game` per participant. Parallel-seed races next, with server-secret seeds. A true shared dungeon last, as a competitive race. Co-op comes after that.
- **Database.** One managed Postgres (v16 or later) is the system of record. The live world stays in the owning process's memory. After every tick it is committed as one hot snapshot row, with events and a Jev call log. There is no Redis in v1.
- **Tick loop.** It moves to a server-side per-game actor. A deadline miss restores the brain from a pre-turn snapshot and takes a fog-safe code fallback move. There is no plan/commit rewrite.
- **Transport.** SSE for server to client, POST for commands. Each viewer gets a fog-projected view, and Reveal becomes admin-only.
- **Keys.** The Jev key is injected per call through the `JevGateway`. Players bring their own key (BYOK), encrypted at rest, with a platform key as a capped free tier. The default is hedge x1 and retries x1.
- **IDs.** Prefixed ULIDs (`gm_`, `par_`, `plr_`, `agt_` and so on).
- **Do not expose this to the internet until Phase 2 is done.** Phase 2 now includes TLS, proxy handling, security headers and closed CORS. Today anyone can POST `/api/step` and spend the shared key, or reset the game (`server.js:85-112`).

Total effort is roughly 12-16 engineer-weeks for Phases 0-3. Phase 4 adds 6-10 weeks. A playground with no users does not need the heavy data machinery, so partitioning, KMS, replays and object-store tiering are deferred (see section 6 and section 11).

## 2. Context

### 2.1 The single-tenant assumptions

| # | Assumption today | Evidence | Resolution |
|---|---|---|---|
| 1 | One module-level `run` and `busy`. A restart loses the game. | `server.js:31,34,105` | `GameRegistry` of `GameActor`s, backed by snapshots (Phase 1) and an optional DB lease (Phase 3). |
| 2 | One explorer per `Game`. | `dungeon.js` constructor ~256-280 | Private games first. `players[]` is deferred to Phase 4. |
| 3 | Fixed disk paths. | `brain.js:31,144`; `turn.js:11,25`; `memory.js:255-256` | `Store` interface, with `FileStore` kept for dev and checks. |
| 4 | Shared env key, hedge x2, retry x3, 20 s timeout. | `jev.js:4-6,17,19` | `JevGateway` with per-tenant key, policy, usage and budgets. |
| 5 | No JSON clone of a `Game`. | AGENTS.md rule 4; `dungeon.js:267,277,278` | Explicit versioned `serialize()` and `restore()`. |
| 6 | Determinism. `shuffle` uses global `Math.random`. | `jev.js:52-58`; `dungeon.js:34-43` | Injected per-actor seeded `rand`. |
| 7 | The browser drives ticks. | `app.js:1262-1305`; `server.js:101-112`; `turn.js:32-44` | Server `TickScheduler`, with cost guards. |
| 8 | Shared-world fog. | `adversary.js:131,139,145,178,196-199,229,282,297-346` | No mutual visibility in v1 of the shared world. `visibleExplorers()` is an opt-in later. |
| 9 | Default real-Jev fallbacks in both brains. | `explorer/brain.js:34,143`; `adversary/brain.js:44,234` | Make `ask` and `decide` required (Phase 0). |

### 2.2 Facts established from the code (and corrections to AGENTS.md)

The code wins (AGENTS.md rule 3). Read constants from code, never from the docs.

- **Adversary constants.**
  - `ADVERSARY_SPEED = 0.6` (`adversary.js:14`), not 0.5.
  - `MAX_SEARCH_TICKS = 18` (`:16`), not 12.
  - `ALERT_STEPS = 24` (`:21`).
  - `FLOOR_PER_ADVERSARY = 150` (`:23`), where AGENTS.md says one per 700 cells.
  - `MAX_ADVERSARIES = 12` (`:24`), where AGENTS.md says a cap of 8.
  - The grace comment at `adversary.js:19` still says "1/ADVERSARY_SPEED = 2 ticks". That is stale at speed 0.6, and so is AGENTS.md's "hit again 6 ticks later".
- **The forced move is dead code.**
  - `availableMoves()` returns `[...steps, STAY]` whenever any step exists (`dungeon.js:308-311`).
  - `takeTurn` throws when the list is empty (`brain.js:193`), so any non-empty list has at least 2 entries.
  - Therefore `forced = legal.length === 1` (`brain.js:194`) is never true. The forced branches at `brain.js:199,252,259,270,295,324,338` never run.
  - Every explorer tick costs at least one logical Jev call. AGENTS.md's "unless the move is forced" is wrong.
- **Light is derivable from `visits`.**
  - `lightAround` is the only writer of `light` (`dungeon.js:197-218`), and it uses `max()`.
  - It is called from the constructor (`:264-267,279`) and from `applyMove` (`:330`).
  - `knownCount`, `knownFloor` and `litOutside` update only on first lighting.
  - So the result depends only on the set of visited cells, not their order. Restore replays `lightAround` over `Object.keys(visits)`. The round-trip test stays as a regression guard.
- **Adversary step order is already numeric.** `byId` uses `localeCompare(..., { numeric: true })` (`adversary.js:334`), and the sort is at `:348`. `a2` sorts before `a10`. No padding work is needed.
- **Runtime files are already ignored.** `.gitignore` lists `memory.json`, `memory.md` and `adversaries.json` under "runtime output". `git ls-files` shows none of them tracked.
- **Only some checks have the network tripwire.** `check-dungeon.mjs:25`, `check-adversaries.mjs:6` and `check-testbed.mjs:6` install it. `check-props.mjs` does not.
- **Ghost load is large.**
  - `alertNearby` switches on every patrolling ghost within `ALERT_STEPS = 24` path steps (`adversary.js:188-200`).
  - A brain-on ghost calls Jev on about 60% of ticks (speed 0.6).
  - The calls run in parallel (`adversary.js:358`).
  - One sighting can therefore cost up to about 12 ghost calls (about 7 expected per tick) plus 1-2 explorer calls per tick, before hedging and retries.
  - Size caps from this formula, not from a flat number.

### 2.3 Unverified, to be tested or measured

- Whether TypeSafe bills an aborted hedge copy. Plan quotas on HTTP posts, not logical calls.
- Event-loop blocking from synchronous BFS under many agents. Measure first.
- Jev latency distribution (p50 and p95). It sets the tick deadline and `tickMs` (see section 3). Gather it with a protected, budget-capped staging run.
- Line numbers cite a dirty working tree with other sessions' uncommitted work. Re-verify before editing.

## 3. Decisions taken

| Topic | Decision | Conflict resolved |
|---|---|---|
| Multiplayer order | Private games, then parallel-seed races, then shared world (race rules), then co-op. | Both sections agree. |
| Database | Postgres only. JSONB for opaque snapshots, normalized tables for what we query, bill or audit. | Redis is rejected for v1. |
| Snapshot write path | **Synchronous transactional commit per tick, before publishing.** One hot `game_state` row, fenced by `expectTick` (and by the lease from Phase 3). Cold snapshots every 25th tick. | Write-behind with a bounded queue is allowed later as an optimisation only. |
| Terminology | **Keep the code class `Run` (`turn.js`).** The DB container is `game` (`gm_`). A participant's tenure is `par_`. | Avoids a rename and a `run_` collision. |
| Patrol RNG state | **Phase 0: draw-count wrapper**, which cannot change draw order. **Later:** an optional `{next, state}` object. | Every seed's dungeon must stay byte-identical (AGENTS.md rule 8). |
| Shuffle RNG | `shuffle(items, rand = Math.random)`. `rand` is **injected through `Run`, `ExplorerBrain` and `stepAdversaries` opts**, the same way `ask` is. Each actor gets a stream seeded from `(game seed, actor id)`, with its draw count persisted. | Both twin suites switch to injected `rand` in the same change (`check-adversaries.mjs:365-366,384` swaps `Math.random` globally today). |
| Seeds | Server-generated with `crypto.randomInt`, always stored in `games.seed`. The `Math.random` fallback in `randomSeed()` (`dungeon.js:45-47`) is not used by the server. | A 32-bit `Math.random` seed is guessable. |
| API shape | `/v1/games/:id/...`. The old `/api/*` is kept only as a dev shim. | |
| Auth | Hosted OIDC provider (magic link and one OAuth provider). Cookie sessions with CSRF protection. | No hand-rolled passwords. |
| Transport | SSE plus POST. Resume via `Last-Event-ID`. Heartbeat every 15 s. A cap on concurrent SSE connections per user, and slow-client backpressure in the hub. | |
| Jev policy | **Cloud default is hedge 1, retries 1, attempt timeout equal to the remaining deadline.** Hedge x2 is opt-in per tenant. | Cuts the worst case from 8 posts (`jev.js:4-5`) to 2. |
| Tick timing | **`tickMs` is a floor.** The next tick starts at `max(tickMs, actual completion)`. The deadline `D` is derived: `D = min(configured D, 0.8 x tickMs)` for a game that runs at a fixed pace, and a game's `tickMs` may not be set below `D / 0.8`. Default numbers (`tickMs` 5 s, `D` 4 s) are placeholders until the staging latency run. | The earlier "D = 4 s below a 1.5 s default tickMs" contradicted itself. A decision tick holds two serial requests (`brain.js:212` then `:280`), so `D` must fit both. |
| Deadline miss handling | **Snapshot the brain before the turn, run `takeTurn` with an AbortSignal-aware `ask`, and on a miss discard that brain instance, restore from the snapshot, apply `fallbackMove`, and keep `pending` set so the decision is re-asked next tick.** | Replaces the plan/commit split. See the rationale below. |
| Ghost-call billing | **Private games: the game owner pays.** Shared worlds: decided in Phase 4 (open question 4). A hard per-game cap applies in both. | |
| Agent model | Agent = `AgentProfile` (versioned, immutable `agent_versions`) + credential. Persona is data, never code. Free text only in single-owner private games. | |
| Key model | BYOK as the main path, plus a platform key with a small capped free tier. Keys are decrypted only inside the gateway. | |
| Key encryption | Phase 2: AES-256-GCM with one app key from the platform secret manager. KMS envelope encryption is deferred until there is a reason. | A playground does not need KMS. |
| Reveal | Admin only, or game owner in a non-competitive game, always audited. | |
| Shared-world fog (v1) | Players cannot see each other. `visibleExplorers()` is an opt-in in Phase 5. | |
| Dungeon persistence | Store `seed`, `gen_version` and a `tiles_hash`. Pin the serialized tiles for long-lived games. Never regenerate "close enough". | AGENTS.md rule 8. |
| Dependencies | The zero-dependency rule ends as a conscious decision: `pg` plus a migration tool. | |
| `memory.md` | Dropped from the write path. Rendered on demand from `memory` (render-only, never read back, `memory.js:256`). | |
| Data-model scope | Phases 1-2 keep one hot JSONB snapshot per game, periodic snapshots and `jev_calls` metadata. Partitioning, handle history, rollups, replays and object-store tiering are deferred to the phase that needs them. | A playground with no users. |

**Why snapshot/restore instead of plan/commit.** The earlier plan wanted a side-effect-free `plan()`. That cannot exist: a decision tick is two serial requests, and the second request's body includes memory already updated by the first answer. `takeTurn` sets `info.lastDecision = step` before its first await (`brain.js:211`), awaits the sentiment (`:212`), then applies `setSentiment` after its await (`:393`). Aborting mid-turn would leave a half-committed brain, and a late answer would still mutate memory. Restoring from a snapshot makes late promises hit a dead object, and it reuses the work of task 0.7. "Apply the sentiment next tick" is then simply "re-ask next tick", so no wall-clock-dependent behaviour needs recording.

## 4. Naming and ID scheme

### 4.1 ID format

**Prefixed ULID: `<prefix>_<26-char lowercase Crockford base32>`.**

- IDs are stored as `text` with `CHECK (id ~ '^plr_[0-9a-hjkmnp-tv-z]{26}$')`.
- High-volume ledgers (`jev_calls`, `events`) use `bigint identity` plus the natural key `(game_id, tick, seq)`.

| Entity | Prefix | Notes |
|---|---|---|
| Account | `acc_` | Billing and login principal. |
| Player | `plr_` | In-game identity. One account can have several players. |
| Agent | `agt_` | A configured Jev explorer. |
| Agent version | `agv_` | Immutable. Pinned per participant. |
| API key row | `key_` | Row id only. The secret is never an id. |
| Game | `gm_` | A private game or a shared world. |
| Participant | `par_` | One explorer's tenure in a game. A player who dies and rejoins gets a new one. |
| Snapshot | `snp_` | |
| API token | `tok_` | Stored hashed. |

**Adversary ids stay `a1..aN`**, unique within a game and stored as `(game_id, adv_id)`. There is no global adversary id. Step order is already numeric (`adversary.js:334,348`), and the cap is 12 (`:24`). Add a check that asserts the `byId` order for `a2` and `a10`.

### 4.2 Human-facing names

- **Handle** (`plr` and `agt`): lowercase `[a-z0-9][a-z0-9-]{2,23}`, unique case-insensitively. A reserved-word list covers `admin`, `api`, `jev` and `system`. A 30-day reservation after release (`handle_history`) is deferred until there are users.
- **Display name**: 1-40 chars, NFKC-normalized, control and bidi characters stripped, not unique.
- **Agent name**: unique per player.
- **Game slug**: a join code such as `amber-ghost-42`, unique among non-archived games, used only in invite URLs.

### 4.3 Database conventions

- `snake_case`. Plural table names, singular column names.
- Foreign keys are `<table_singular>_id`.
- Timestamps are `timestamptz` named `*_at`.
- Money is integer micro-units, never float.
- Enums are `CHECK` constraints on text.
- JSONB keys are snake_case, matching AGENTS.md conventions.
- Indexes are `ix_<table>_<cols>`. Unique indexes are `ux_<table>_<cols>`.

### 4.4 Object-store layout (deferred until volume needs it)

Keys are partitioned by `gm_id`, so deleting a game is one prefix delete. Never put handles or display names in keys.

```
s3://jev-dungeon-<env>/
  snapshots/{gm_id}/{tick:08d}.json.zst
  exports/{acc_id}/{yyyymmdd}/{export_id}.zip
```

### 4.5 Environment variables

| Var | Purpose |
|---|---|
| `JD_DATABASE_URL`, `JD_DB_POOL_MAX` | Postgres. |
| `JD_APP_KEY` (secret manager; dev only from env) | Encrypts stored BYOK keys. |
| `JD_NODE_ID` | Lease owner id (Phase 3). Defaults to hostname plus pid. |
| `JD_JEV_BASE_URL`, `JD_JEV_HEDGE`, `JD_JEV_RETRIES`, `JD_JEV_TIMEOUT_MS` | Replace the constants at `jev.js:4-6`. |
| `JD_PLATFORM_JEV_API_KEY` | Platform key. Renamed from `JEV_API_KEY`, with a transitional alias (read at `jev.js:17`). Read only by the gateway. |
| `JD_JEV_LIVE=1` | **The only way to enable the paid gateway.** Unset means a stub gateway or a hard refusal. This is the platform kill switch. |
| `JD_DAILY_POST_CAP` | Platform-wide daily cap on Jev HTTP posts. Hit means every game pauses. Works from Phase 1, independent of accounts. |
| `JD_GAME_MAX_TICKS`, `JD_GAME_MAX_POSTS` | Per-game limits (Phase 1 defaults, refined by quotas in Phase 2). |
| `JD_AUTOPLAY` | Default off in Phase 1. Autoplay needs an explicit flag per game and a viewer. |
| `JD_TICK_MS`, `JD_DEADLINE_MS`, `JD_MAX_INFLIGHT` | Scheduler and gateway limits. |
| `JD_SNAPSHOT_EVERY` | Cold-snapshot cadence (default 25). The hot row is written every tick. |
| `JD_RETENTION_*` | Retention windows (Phase 3). |
| `PORT`, `TESTBED` | Existing (`server.js:13,16`), unchanged. |

- Secrets come from the platform secret manager.
- `process.loadEnvFile('../.env')` (`server.js:8`) stays only as a dev branch guarded by `NODE_ENV !== 'production'`.
- A missing key fails at boot with a clear message that never prints values. The hard throw at `server.js:8-9` is replaced.
- Never read or print `../.env`.

## 5. Target module layout

New files are marked (new). Ownership follows AGENTS.md rule 9.

```
server.js                         HTTP, static whitelist (keep STATIC, server.js:20-28), routes, boot, shutdown
src/config.js (new)               validated env config, fail fast
src/jev.js                        transport only: apiKey, policy, signal, onAttempt params; returns {answers, usage}; no env read
src/runtime/
  registry.js (new)               GameRegistry: Map<gameId, GameActor>, lazy load, evict
  actor.js (new)                  GameActor: per-game tick loop, the only mutator, per-game try/catch isolation
  scheduler.js (new)              deadline race, overrun skipping, degraded-player counter
  jev-gateway.js (new)            the only builder of real ask/decide: metering, budgets, kill switch, semaphore, breaker, error classes
  view-projector.js (new)         per-viewer fog-safe views and deltas
  hub.js (new)                    SSE fan-out, heartbeat, Last-Event-ID, connection caps
src/store/
  store.js (new)                  Store interface
  file-store.js (new)             legacy and dev
  memory-store.js (new)           checks and testbed
  pg-store.js (new)               production
  migrations/ (new)               SQL plus snapshot-JSON migrations (v1 to v2)
src/ids.js (new)                  prefixed ULID, handle validation
src/agents/profile.js (new)       AgentProfile validation, clamps
src/characters/explorer/fallback.js (new)   fog-safe fallbackMove(world)
src/characters/explorer/brain.js  serialize(), static restore(), required ask, injected rand
src/dungeon.js                    Game.serialize(), static restore(), rng wrapper (no new relative imports)
src/characters/adversary/adversary.js   serialize()/restore(), keeps six public fields
scripts/lib/no-network.mjs (new)  shared throwing fetch tripwire
scripts/check-persistence.mjs, check-runtime.mjs, check-views.mjs, check-paid-paths.mjs (new)
.github/workflows/ci.yml (new)    no secrets, egress blocked
```

Constraints on this layout:

- Explorer files import nothing from `src/store/` or `src/runtime/`. Storage and Jev access are injected.
- `dungeon.js` may add no relative import beyond the single `import { placeProps } from './props/place.js';` line, which must stay byte-identical. `check-props.mjs` copies that file alone.
- `fallback.js` lives in the explorer chain, so the static guard scans it.
- `check-paid-paths.mjs` greps that `askJev(` appears only in `jev.js` and `jev-gateway.js`, and that no brain constructor has a default asker.

## 6. Database schema

All DDL is illustrative Postgres. **Phases 1-2 use the reduced set below.** Partitioning is added only once volume is measured (the tables are declared so that adding `PARTITION BY` later is a migration, not a redesign).

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

- AES-256-GCM with the app key. The plaintext lives only in memory for one call.
- The key is never logged, never put in a snapshot or `state`, and never sent to the browser.
- The API returns only `{id, label, last4, status}`. There is no reveal endpoint.
- Rotation creates a new `key_` row. Revocation is soft, and a revoked key fails closed.
- Validate a key on add with one cheap Jev call, rate-limited per account.
- Disclosure and consent: the UI and terms state that memory, persona text and situation text are sent to TypeSafe, and say what the BYOK data-processing terms are. Request-body logging is opt-in per owner.

### 6.2 Agents (Phase 2)

```sql
CREATE TABLE agents (
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

`AgentConfig` (schema 1, validated like `validateMemory`):

```jsonc
{ "schema": 1,
  "objective": "<=400 chars",
  "default_sentiment": "cautious",
  "sentiment_overrides": { "cautious": { "min_gap": 3, "end_ticks": 4 } },
  "flavour": "<=200 chars",
  "review_every": 8, "redecide_cooldown": 3,
  "model": "jev-latest" }
```

- Clamps: `min_gap` 1..6, `end_ticks` 1..8, `review_every` 4..16, `redecide_cooldown` 1..6. `model` is an allow-list, not free text. It is hard-coded today (`jev.js:40`, `brain.js:173`, `adversary/brain.js:218`).
- Persona text may only reach fields `validateMemory` already bounds: `memory.objective` (400) and `profile_note` (200).
- Persona text never goes into `RULES` or `questions`. `RULES` interpolates `EXPLORER_LIVES`, `GRACE_TICKS` and `speedPhrase`.
- No config field may reach a `KnownWorld` read path or change fog behaviour.
- The constants (`SENTIMENTS` at `brain.js:43-80`, `DEFAULT_SENTIMENT` at `:81`, `REVIEW_EVERY`, `APPROACH_FAILING` and `REDECIDE_COOLDOWN` at `:28-30`) become defaults that a profile overrides.

### 6.3 Games and participants (Phase 1 creates `games`; participants from Phase 2)

```sql
CREATE TABLE games (
  id text PRIMARY KEY,                        -- gm_
  slug text UNIQUE,
  mode text NOT NULL CHECK (mode IN ('private','shared')),
  status text NOT NULL CHECK (status IN ('lobby','running','paused','finished','abandoned')),
  pause_reason text,                          -- 'user'|'budget'|'auth'|'cap'|'kill_switch'|'idle'
  world_kind text NOT NULL CHECK (world_kind IN ('generated','testbed')),
  seed bigint NOT NULL,                       -- server-generated (crypto), never sent to clients
  testbed_config jsonb,
  gen_version text NOT NULL, tiles_hash text, dungeon_tiles_ref text,
  rules_version text NOT NULL,
  constants jsonb NOT NULL,                   -- copied from code: ADVERSARY_SPEED, GRACE_TICKS, ALERT_STEPS, MAX_ADVERSARIES, FLOOR_PER_ADVERSARY, LIGHT_RADIUS, EXPLORER_LIVES
  tick int NOT NULL DEFAULT 0,
  rng_state jsonb NOT NULL,                   -- {patrol:{draws}, shuffles:{actorId:draws}}
  tick_ms int NOT NULL, deadline_ms int NOT NULL,
  autoplay boolean NOT NULL DEFAULT false,
  max_ticks int NOT NULL, max_posts int NOT NULL,
  owner_node text, lease_expires_at timestamptz, lease_epoch bigint NOT NULL DEFAULT 0,  -- used from Phase 3
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

In private mode there is exactly one participant per game. The schema is identical for a shared world.

### 6.4 State and events

```sql
CREATE TABLE game_state (                     -- hot row: world + explorer + adversaries in one JSONB, one write per tick
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

- The separate `explorer_state`, `adversary_state` and `ticks` tables are dropped from Phases 1-2. Everything restorable lives in `game_state.world`. The fallback source per tick (`jev`, `fallback`) is recorded in the `events` stream as a `move_source` event.
- Event `type` strings are exactly today's (`hit`, `caught`, `spotted`, `brain_on`, `brain_off`, `lost_sight`...). The `hit` payload keeps `{id, at, health}`. No `gave_up` event exists, so none is modelled.

### 6.5 Jev calls, ledger, quotas

```sql
CREATE TABLE jev_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id text NOT NULL, tick int NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('explorer','adversary')),
  actor_id text NOT NULL,                     -- par_ id or a1..aN
  kind text NOT NULL,                         -- sentiment|tick|adversary
  billed_to_account text NOT NULL, key_id text NOT NULL,
  request_sha text NOT NULL, request_body text,            -- body only when the owner opted in
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

- **Billing unit is HTTP posts, not logical calls.** `attempts` counts every post, including aborted hedge losers and retries. Today's worst case is `HEDGE x (RETRIES+1) = 8` posts (`jev.js:4-5`). Treat aborted copies as billable until TypeSafe confirms otherwise.
- **`per_tick_attempt_cap` is sized from a formula, not a flat 8.** Worst case per tick = `(MAX_ADVERSARIES = 12 brain-on ghosts + 2 explorer calls) x posts_per_call`. With hedge 1 and retries 1 that is 14 x 2 = 28 posts. A cap below the formula forces ghosts onto the code BFS fallback (`adversary.js:369-372`), which is behaviour drift. So the rule is: size the cap at or above the formula, and where a cap truly binds, count it as accepted drift and surface it as a `cap_fallback` event.
- Deferred until needed: `usage_rollups` (aggregate with queries on `jev_calls` until slow), `replays`, `handle_history`, partitioning.
- `audit_log(id, actor_account, action, subject_type, subject_id, at, meta jsonb)` covers key create, rotate and revoke, quota changes, Reveal and spectator access, and deletions (Phase 2).

## 7. Snapshot, restore and determinism rules

These apply to every phase.

**Never use `JSON.parse(JSON.stringify(game))`, `{...game}`, `structuredClone`, or a spread of an `Adversary`** (AGENTS.md rule 4). The reasons are the `litOutside` Set (`dungeon.js:267`), prototype methods, and the private `#hunt`, `#route` and `#lastRequestBody` on `Adversary` (`adversary.js:43-45,54-82`).

### 7.1 `Game`

- `serialize()` emits `{schema, steps, pos, health, maxHealth, graceTicks, won, lost, caughtBy, trail, visits (ordered), litOutside (sorted array), adversaryTicks, patrolRand: {draws}}`. Placement is in `dungeon.js` with no new relative imports.
- `static restore(dungeon, snap)` builds through `new Game(dungeon)` and then overwrites fields. `light`, `knownCount` and `knownFloor` are recomputed by replaying `lightAround` over `Object.keys(visits)` (`dungeon.js:197-218`). This is sound by construction (section 2.2). The round-trip test asserts byte equality as a regression guard.
- `constants` records `LIGHT_RADIUS`, and restore refuses a mismatch.
- The dungeon is not in the snapshot. It is rebuilt from `seed` plus `gen_version` (`generateDungeon`, `dungeon.js:151-191`) or from `testbed_config` (`buildArena`).
  - Any `rng()` reorder changes every seed (AGENTS.md rule 8). So `gen_version` and `tiles_hash` are stored.
  - Long-lived games pin the serialized dungeon blob. Restore prefers the pinned blob and fails loudly on a hash mismatch.

### 7.2 `Adversary`

- Keep the six public fields and their order (`id,pos,mode,budget,lastSeen,goal`). Do not add public fields.
- `serialize()` emits `{schema, public, hunt, route}`. The hunt state is `{on, inSight, heading, ticksSinceSeen, swept (Set to array), cutOff, dists, trend, pickApproach, memory}`.
- `static restore()` constructs through `new Adversary({id,pos})` and then uses the private setters. `lastRequestBody` is audit only.

### 7.3 `ExplorerBrain`

- The constructor builds fresh memory, runs `approachTarget` and sets `pending = 'start'` (`brain.js:141-156`). Restoring through it would buy an extra two-call paid `start` decision and clobber memory. `restore` must **bypass** the constructor, for example with a private `{restoreFrom}` init path.
- Snapshot content:
  - `memory` (plain JSON, validated).
  - `revisitWindow`: the `WeakMap` content at `memory.js:40`, restored through an exported `setRevisitWindow(memory, arr)`.
  - `review`: `#review` (`brain.js:133`).
  - `encounter`: Sets and the Map converted to arrays, plus `pending` and `lastDecision`.
  - `tacticGoal`: `#tacticGoal` (`brain.js:138`).
  - the draw count of its shuffle stream.
- `lastDecision = -Infinity` is encoded as `null` and decoded back (`brain.js:136`).
- The brain is rebuilt from a `KnownWorld` over the restored `Game`. It never holds a `Game`.
- **Deadline use.** The actor takes a serialized brain snapshot before each turn (cheap relative to a Jev call). A deadline miss discards the instance and restores that snapshot (section 3).

### 7.4 RNG

| Source | Location | Fix |
|---|---|---|
| Global `Math.random` shuffle | `jev.js:52-58`; explorer `brain.js:250,372,403,463`; adversary `adversary/brain.js:171,201` | `shuffle(items, rand)` with `rand` injected through opts and a per-actor seeded stream. |
| `randomSeed()` when no seed | `dungeon.js:45-47`; `server.js:55` | Server generates the seed with `crypto.randomInt` and stores it. |
| `patrolRand` closure | `dungeon.js:34-43,278`; `adversary.js:163` | Draw-count wrapper (Phase 0), optional state object later. |
| Twin tests swapping `Math.random` | `check-adversaries.mjs:365-366,384`; explorer twins in `check-dungeon.mjs` | Both suites switch to injected `rand`, giving both twins the same stream, in the same change. |

- **Keep the synchronous in-id-order build of adversary request bodies** (AGENTS.md "Run") until per-actor streams land and the fog twin is re-proven.
- Shuffle changes alter the option order Jev sees. This is an accepted behaviour change and must be documented. Phase 0 is "no change to dungeon generation or game rules", not "no change to Jev's option order".
- Replay as a product feature is deferred. Recording `request_sha` and answers is kept because rebuilding a request body and comparing it byte for byte doubles as a fog-regression detector in checks.

### 7.5 Versioning

- Every snapshot carries `schema`. `migrations/snapshot/` holds pure `v1 to v2` functions that `restore` chains.
- A game whose `rules_version` differs on deploy drains and finishes on the old build (default).

## 8. Phased plan

Effort is in engineer-days unless stated.

### Phase 0. Foundations and paid-path closure (no change to game rules)

**Goal.** Create the seams, close every unmetered paid path, and prove it with free checks.

**Ownership.** These tasks touch files owned by the world, brain and adversary agents, so they need explicit user authorisation (AGENTS.md rule 9). Run `git status` first, because the tree has other sessions' uncommitted work.

| # | Task | Files |
|---|---|---|
| 0.1 | Shared network tripwire. Move the throwing `fetch` (`check-dungeon.mjs:25`) into `scripts/lib/no-network.mjs`. Import it in every check, **including `check-props.mjs`**, which has none today. | `scripts/*` |
| 0.2 | **CI pipeline, moved up from Phase 3.** No secrets, egress to `api.typesafe.ai` blocked, runs `node --check` on all files plus every `check-*.mjs`. `--live` and `/api/step` equivalents never run in CI. | `.github/workflows/ci.yml` |
| 0.3 | **Close the paid-path bypass.** Make `ask` and `decide` required: remove `askReal` and `this.#ask = ask ?? askReal` (`explorer/brain.js:34,143`) and `jevAsk` and `ask ?? jevAsk` (`adversary/brain.js:44,234`); constructing without them throws. `jev.js` takes `apiKey` explicitly and stops reading `process.env.JEV_API_KEY` (`jev.js:17`). Only `server.js` boot wiring (a dev gateway, gated by `JD_JEV_LIVE=1`) builds real askers. New `check-paid-paths.mjs` greps for `askJev(` outside `jev.js` and the gateway. Update every script and check that currently relies on the default. | `explorer/brain.js`, `adversary/brain.js`, `adversary.js`, `jev.js`, `turn.js`, `server.js`, `scripts/*` |
| 0.4 | `Store` interface plus `FileStore` as the default. `memoryDir` and `dir` stay as sugar. Replace the three writes at `brain.js:335,348,356` and the write at `turn.js:39` with one tick-level call. | `src/store/*`, `turn.js:11,20,25,39`, `brain.js:31,141-144`, `memory.js:255-256`, `adversary/memory.js:109-112` |
| 0.5 | `MemoryStore`. Convert `check-testbed.mjs` and `run-testbed.mjs` to it, removing the temp-dir handling (`check-testbed.mjs:150`). | `scripts/*` |
| 0.6 | `jev.js` options: `apiKey`, `policy` (`hedge`, `retries`, `timeoutMs`), external `signal`, abortable backoff, `onAttempt` per HTTP post, returns `{answers, usage}`. Defaults reproduce today's constants exactly (`jev.js:4-6`). | `jev.js:4-6,15,17,19,40-50` |
| 0.7 | `shuffle(items, rand = Math.random)`, with `rand` injected through `Run`/`ExplorerBrain`/`stepAdversaries` opts and per-actor seeded streams with the draw count tracked. Update both twin suites in the same change. | `jev.js:52-58`, `brain.js`, `adversary/brain.js`, `check-adversaries.mjs:365-366,384`, `check-dungeon.mjs` |
| 0.8 | `patrolRand` draw-count wrapper. It must not change draw order. | `dungeon.js:34-43,278`, `adversary.js:163` |
| 0.9 | `Game.serialize()/restore()`, `Adversary.serialize()/restore()`, `ExplorerBrain.serialize()/restore()` (bypassing the constructor), `setRevisitWindow`. | `dungeon.js`, `adversary.js`, `brain.js`, `memory.js` |
| 0.10 | Doc sync. Fix in AGENTS.md and CONTRACT.md: the constants drift (speed 0.6, search 18, alert 24, floor-per-ghost 150, cap 12), the dead forced-move claim and cost lines, the stale grace comment at `adversary.js:19`, and the "hit again 6 ticks later" claim. | `AGENTS.md`, `CONTRACT.md`, `adversary.js:19` |
| 0.11 | Decide the dead `forced` branches (`brain.js:199,252,259,270,295,324,338`): remove them or redefine "forced" (for example, one step plus `STAY`). Default is removal, with an explicit test. | `brain.js` |
| 0.12 | Fix the stale `check-dungeon --measure` (sizes 140..150 against `MAX_SIZE = 90`). | `check-dungeon.mjs:656` |

The plan/commit split of `takeTurn` is **removed** from this plan (see section 3).

**Exit criteria.**
- `node --check` passes on all files, and the CI pipeline is green with egress blocked.
- The existing `check-dungeon.mjs`, `check-adversaries.mjs`, `check-testbed.mjs` and `check-props.mjs` pass (the twin suites changed only to inject `rand`).
- The 200-seed `JSON.stringify(generateDungeon(seed))` determinism check passes (`check-dungeon.mjs:97`).
- `check-paid-paths.mjs` passes: no `askJev(` outside the allowed files, and both brains throw when built without `ask`/`decide`.
- New `scripts/check-persistence.mjs` passes:
  - `serialize -> JSON -> restore -> serialize` is byte-equal, including `litOutside` at a map edge.
  - N stubbed ticks on the original and the restored copy, with identical stub answers, give equal event streams and request bytes.
  - A restored brain makes no extra `start` decision.
- The static fog guard still passes. The `node:fs/promises` allowlist entry is removed once persistence is out of `memory.js`.

**Effort.** About 20-25 days. The long pole is 0.9 (4-6 days).

**Dependencies.** None.

**Risks.**
- The `check-props` single-import limit on `dungeon.js`.
- Concurrent edits by other sessions.
- A missed private state field. The round-trip test is the safety net.
- Making `ask`/`decide` required breaks every script that relied on the default. That is intended, and the tripwire turns a miss into a failure rather than a bill.

### Phase 1. Persistence, multi-game hosting and the cost guard (private games)

**Goal.** Many concurrent, durable, fog-safe private games on one node, still single-user and not internet-facing, with spend bounded before the server drives any tick.

| # | Task | Files |
|---|---|---|
| 1.1 | **Cost guard (first task of the phase).** `JD_JEV_LIVE` kill switch (off means no paid calls and games pause with `kill_switch`), `JD_DAILY_POST_CAP` platform-wide post counter, per-game `max_ticks` and `max_posts`, and pause-on-cap with a reason in `games.pause_reason`. Autoplay is off by default (`JD_AUTOPLAY`). | `src/runtime/jev-gateway.js` (minimal form), `config.js` |
| 1.2 | `GameRegistry` and `GameActor`. They replace `run` and `busy` (`server.js:31,34`). The actor's own tick loop is the per-game mutex, and routes never call `playTurn` directly. **Each actor tick is wrapped in try/catch so one game's exception pauses that game with a reason and cannot affect others.** | `src/runtime/registry.js`, `actor.js`, `server.js:54,85-112` |
| 1.3 | Postgres schema (section 6.3-6.5 reduced set), migrations, and `PgStore` with `loadGame`, `saveTick` (one transaction, `expectTick` fence). Lease functions are Phase 3. | `src/store/pg-store.js` |
| 1.4 | `TickScheduler`. Per tick: snapshot the brain, run `takeTurn` for each active participant in parallel with an AbortSignal-aware `ask`, race it against the deadline `D`, and on a miss restore from the snapshot and use `fallbackMove`. Apply moves in slot order, run `stepAdversaries`, persist, then publish. `tickMs` is a floor, and overruns are skipped rather than queued. Record the move source in the event stream. | `src/runtime/scheduler.js` |
| 1.5 | Fog-safe explorer fallback: `fallbackMove(world)` over `KnownWorld` only. Order: chest if adjacent on a known path, then step away from the nearest visible adversary using `knownDistances`, then toward the nearest frontier, then `STAY`. Do not use `legal[0]`. | `src/characters/explorer/fallback.js` |
| 1.6 | Adversary deadline: add the same race to `decide`. It already falls back to a code BFS move (`adversary/brain.js:233-236`; `adversary.js:369-372`). **This edits `adversary.js` and is counted as a small adversary-code change**, not "no adversary change". | `adversary.js` |
| 1.7 | **Error classification.** The gateway classifies failures as `transient` (timeout, 429, 529, network), `auth` (401/403) or `budget`. Only `transient` takes `fallbackMove`. `auth` and `budget` pause the game with a stated reason, and an auth failure marks the key `failing`. Today `takeTurn` has no try/catch and a Jev error rejects the turn (`brain.js:264,280`; non-retryable statuses throw at `jev.js:34`; surfaced as 502 at `server.js:108-111`). | `jev-gateway.js`, `scheduler.js` |
| 1.8 | Degraded-player rule: after N (default 5) consecutive transient fallbacks, mark the participant `degraded`. It makes no Jev calls and runs code-only until a probe succeeds. | `scheduler.js` |
| 1.9 | `ViewProjector.forPlayer(game, par, since)` and an SSE hub (`GET /v1/games/:id/events`, heartbeat 15 s, `Last-Event-ID`, per-user connection cap, backpressure that drops slow clients). **Every current `publicView` field gets a ruling (section 10).** Remove `tiles`, `treasure` and `seed` from `publicView` (`dungeon.js:358-375`) and the full adversary list from `Run.view()` (`turn.js:46-58`). Memory leaves `/api/state` (`server.js:36,82`). | `src/runtime/view-projector.js`, `hub.js`, `dungeon.js`, `turn.js`, `public/app.js:273,280,497-505,541-542,838,868` |
| 1.10 | Pause and idle rule. A game with no viewers and no autoplay flag stops ticking and snapshots. | `actor.js` |
| 1.11 | Boot and shutdown. On boot, resume games with `status=running` that have `autoplay` set. On SIGTERM, stop ticks, snapshot every game, close the server. Add `/healthz` and `/readyz`. | `server.js` |
| 1.12 | Dev legacy shim. `/api/state`, `/api/new`, `/api/step` map onto a private game under `NODE_ENV=development` only. They return 404 in production, so rule 2 stays true in dev. | `server.js` |
| 1.13 | Retire `memory.md` generation from the write path (render on demand). Make `store` required in non-test construction. Delete the `MEMORY_DIR`/`DIR` defaults (`brain.js:31`, `turn.js:11`). The three runtime files are already gitignored and untracked, so `.gitignore` is untouched. | `brain.js`, `turn.js` |

**Exit criteria.** Free checks green, plus new ones:
- `check-runtime.mjs`:
  - Isolation: two games interleaved in one process give the same results as running alone, with per-actor `rand`.
  - Nothing is written under the repo root (`memory.json`, `memory.md`, `adversaries.json`) when a store is injected.
  - Deadline: a stub `ask` that never resolves yields a fallback within `D + epsilon`, restores the brain from the snapshot, keeps `pending` set, and does not stall another game. A late resolve afterwards does not mutate the live brain.
  - Crash and restore resumes from the last committed tick without an extra `start` decision.
  - Cost guard: with `JD_JEV_LIVE` unset, no gateway call is made. A daily-cap hit pauses every game. A per-game cap hit pauses that game with a reason.
  - Error classes: an `auth` error pauses the game rather than falling back forever. An exception in one actor leaves other actors ticking.
  - Overrun skipping, pause and resume.
- `check-views.mjs`: for every tick of a scripted game, the serialized `PlayerView` contains no hidden adversary coordinate, no unlit treasure, no unknown tile, no `seed`, and no hidden prop or decor. The twin approach (`check-dungeon.mjs:227-350`) is reused: views for the same player must be byte-identical when hidden state (including hidden props) is scrambled.
- Twin tests cover `fallbackMove`, and it passes the static guard.
- Staging double-write (`FileStore` plus `PgStore`) shows identical memory JSON each tick.
- A staging latency run (budget-capped, protected, manual) records Jev p50 and p95 for both explorer and ghost calls, and fixes the default `D` and `tickMs`.

**Effort.** About 30-38 days.

**Dependencies.** Phase 0.

**Risks.**
- The renderer assumes full `tiles` (`app.js:497-505,838`), `game.treasure` (`541-542,868`) and the full `props` list (`app.js:273,280`). It already guards `treasure === null` for testbeds. This is a UI-agent task and needs a visual check.
- Event-loop CPU under load is an inference, not measured. Profile before sharding.
- Behaviour drift on the existing explorer, caught by keeping the existing checks green.

### Phase 2. Players, agents, auth, BYOK, quotas, and internet hardening

**Goal.** Safe to put on the internet, with real accounts, per-player cost control, and transport security in place.

| # | Task | Files |
|---|---|---|
| 2.1 | ID library (`src/ids.js`), handle rules and uniqueness. | `src/ids.js` |
| 2.2 | OIDC auth, server-side sessions (HttpOnly, Secure, SameSite=Lax), CSRF through an Origin check or token, roles (`owner`, `player`, `spectator`, `admin`). Every `:id` route checks membership. No route accepts a bare `gameId` without a session. | `server.js`, `src/auth/*` |
| 2.3 | **Transport hardening (moved up from Phase 3.6).** HTTPS termination, `trust proxy`, security headers (CSP, `X-Content-Type-Options`, `Referrer-Policy`), CORS closed by default. Today `send()` sets only `Content-Type` (`server.js:47-50`). Cookie `Secure` and CSRF checks depend on this. Static assets keep the `STATIC` whitelist (rule 5). | `server.js` |
| 2.4 | `JevGateway` (full form): per-tenant key, per-call usage rows (one per HTTP post), global in-flight semaphore (`maxInflight` default 32, queue wait counts against the deadline), per-tenant budgets, circuit breaker on 429/529 storms, token-bucket rate limit. Default policy hedge 1, retries 1. Caps are sized from the formula in section 6.5. | `src/runtime/jev-gateway.js` |
| 2.5 | Encrypted credential store (BYOK). Decrypt only inside the gateway. Redact `Authorization` from error text (the error body is already sliced to 300 chars in `jev.js`). Add log redaction for `key`, `authorization` and `apiKey`. | `api_keys`, gateway |
| 2.6 | Quotas and per-game budgets. On a cap hit the game pauses with a clear reason, and platform-key users are told to add their own key. Never silently fall back. | `quotas`, `scheduler.js` |
| 2.7 | `AgentProfile` and persona wiring into `ExplorerBrain({ask, store, runId, profile})`. | `src/agents/profile.js`, `brain.js:141-156` |
| 2.8 | Platform-key free tier with a small allowance. | gateway |
| 2.9 | Abuse limits: per-user and per-IP rate limits on game creation and join, per-user ceilings on tick rate, games and total budget, a max ticks per game, an idle timeout, 413 for oversize bodies (limit 20 kB, `server.js:42`). Client-supplied testbed config is disabled in production (`server.js:94`, and the `TESTBED` env at `server.js:16-19`) unless the user has a `testbed` entitlement. `normalizeConfig` already bounds sizes. Per-user SSE connection cap. | `server.js` |
| 2.10 | API surface (section 9), JSON error contract `{error:{code,message}}`, and fixing the swallowed `busy.catch(() => {})` (`server.js:54`). | `server.js` |
| 2.11 | Spectator view (delayed, fogged) and a leaderboard (steps to chest, lives lost, Jev cost). Thoughts are an opt-in, owner-only channel. | `view-projector.js` |
| 2.12 | **Parallel-seed races.** A lobby with a separate `Game` per participant on one shared seed. Race seeds are **server-secret, generated with `crypto`, and single-use.** The host never chooses one in competitive mode. They are withheld from views and exports until the race ends (the seed determines the whole map including the chest, and generation is deterministic and open). | `registry.js`, lobby routes |
| 2.13 | Persona prompt-injection controls (see section 12). | `profile.js`, tests |
| 2.14 | Audit log. | `audit_log` |

**Exit criteria.** Free checks green, plus:
- Authz matrix test: each route by role (none, spectator, player, other-game player, admin) against expected status.
- Transport test: the response headers on `/` and the API include the CSP and security headers, the session cookie is `Secure` and `HttpOnly`, and a cross-origin write without a valid Origin or CSRF token is rejected.
- Gateway test against a fake HTTP server. It asserts posts are counted including hedge losers, a 429 storm opens the breaker, an `auth` response pauses the game and marks the key `failing`, and budget exhaustion pauses the game without further calls.
- Key canary test: a canary key never appears in logs, errors, views or snapshots.
- Injection test: scrambling all player-controlled strings changes the request body only inside the permitted fields.
- Race test: a race seed does not appear in any view, event or response before the race ends.

**Effort.** About 38-44 days.

**Dependencies.** Phase 1.

**Risks.**
- Key leakage through logs.
- Cap UX.
- Scope creep in auth. Use an off-the-shelf provider.
- Hedge billing is unconfirmed. Count conservatively until TypeSafe answers (open question 1).

### Phase 3. Cloud deployment, ops and scale readiness

**Goal.** Repeatable deploys, observability, and a path to more than one node.

| # | Task |
|---|---|
| 3.1 | Multi-stage Dockerfile on `node:22-slim`, non-root. Add `"engines": {"node": ">=20.12"}` to `package.json` (`process.loadEnvFile` needs it, `server.js:8`). Add a lockfile. |
| 3.2 | `src/config.js` validated at boot. Environments: `dev` (stub gateway by default), `staging` (real Jev with a low-budget key), `prod`. The paid gateway requires `JD_JEV_LIVE=1`. A `JevGateway` constructed in test mode without an injected stub throws. |
| 3.3 | A protected manual workflow for live runs, with a hard budget cap. (The no-egress CI itself is already in Phase 0, task 0.2.) |
| 3.4 | Observability. Structured JSON logs with the mandatory fields `ts, level, gameId, tick, actor, tenant, event`. Metrics: `jev_calls_total`, `jev_http_posts_total`, `jev_latency_seconds`, `tick_duration_seconds`, `tick_overrun_total`, `fallback_moves_total`, `cap_fallback_total`, `players_degraded`, `breaker_state`, `event_loop_lag_seconds`, `store_write_seconds`, `sse_clients`. Dashboards for cost and Jev latency. One trace per tick. Alerts: fallback rate over 20 percent for 5 min, breaker open, event-loop lag over 200 ms, daily budget at 80 percent, lease flapping. |
| 3.5 | Retention jobs, and partition management if volume has justified partitioning (section 11). |
| 3.6 | Static assets behind a CDN with cache headers and ETag (keep the `STATIC` whitelist, rule 5). (TLS, headers and CORS already shipped in Phase 2.3.) |
| 3.7 | CPU profiling (`event_loop_lag`, BFS cost). If it bites, run `takeTurn` in a `worker_threads` pool. This needs a serializable world view. |
| 3.8 | Leases and fencing for horizontal scale: `games.owner_node`, `lease_expires_at`, `lease_epoch`. Renew about every 5 s. Every `saveTick` includes `WHERE lease_epoch = $mine`. Routing is sticky by `gameId`. **Only do this on a measured need.** |
| 3.9 | Legacy cutover finish: update AGENTS.md rule 7 and CONTRACT.md in the same PR. Optional `import-legacy` archive script (historical only). |

**Exit criteria.** The runtime checks pass in CI with no network and no key. Kill and restart of a node resumes games from the last snapshot. Graceful drain works. With leases enabled, a zombie owner's write is rejected.

**Effort.** About 12-18 days (leases about 5 of those).

**Dependencies.** Phase 2.

**Risks.** Fencing mistakes. Premature multi-process work.

### Phase 4. Shared-world multiplayer (race rules)

**Goal.** Several explorers in one dungeon, competitive, with no mutual visibility at first.

**Decision first.** Resolve open question 3 (race win rule) and open question 4 (ghost billing).

| # | Task | Files |
|---|---|---|
| 4.1 | `ExplorerState` struct and a `players` Map inside `Game`. Keep delegating single-player getters (`game.pos`, `game.health`...) so existing checks stay green at each step. `twin(overrides)` copies the Map. Keep it all in `dungeon.js` (single-import rule). Snapshot schema bump to v2 (`players[]`). Light stays **per explorer** and is never merged in storage. | `dungeon.js` |
| 4.2 | `KnownWorld(game, playerId)`. All reads delegate to that player's state. | `known-world.js` |
| 4.3 | Static guard: ban `players.` and `.players` in explorer files except `known-world.js`, with a self-test fixture. | `check-dungeon.mjs` section 0, ~36-76 |
| 4.4 | Multi-target adversaries. Sensing takes the explorer (`adversary.js:131,139,145`). `chooseTarget` has hysteresis and breaks ties by player id. `targetId` and per-target `lastSeen` stay private in `#hunt`. `touchCheck` and `knockBack` run per explorer (`adversary.js:297-302,313`). Grace is per explorer (`:331,346`). The hit latch becomes `Set<playerId>`. `hit` events gain `player`. **There are three early-return sites in `stepAdversaries` and all three change:** (a) the world-wide `won || lost` return at `:344`, which becomes "return when no explorer is active"; (b) the pre-move touch loop return at `:349`; (c) the post-step touch return at `:382-384`. A lethal hit marks only that explorer out, and the remaining ghosts still step and hit-check the other explorers that tick. `Game.damage` is a no-op once won or lost (`dungeon.js:292`), so under a shared `won` latch the damage check must be per explorer too. Knockback never lands on any living explorer's cell. Keep "touch is damage, not instant loss". | `adversary.js`, `adversary/brain.js:47-53`, `adversary/perception.js:209-224`, `dungeon.js:292` |
| 4.5 | Race ruleset. The first explorer on the chest ends the game, with a tie-break by player id. `Game.won` and `Game.lost` become derived. | `dungeon.js`, `turn.js` |
| 4.6 | Multi-start spawn as a **separate post-pass with its own stream**. Changing the call order inside `spawnAdversaries` or `generateDungeon` changes every seed (rule 8). The count formula (`FLOOR_PER_ADVERSARY = 150`, cap 12, `adversary.js:23-24,112`) is revisited for several explorers. | `adversary.js:110-127` |
| 4.7 | Per-game ghost-call cap enforced in `decide`. Capped ghosts use the code BFS fallback (`adversary.js:369-372`). The billing policy comes from open question 4. | gateway |

**Exit criteria.**
- Existing checks still green with the single-player getters.
- New twin tests:
  - Other-explorer twin: scrambling B's position, health, trail, light, memory and sentiment leaves A's request bytes identical.
  - Cross-player isolation: B's moves never change A's `light`, `visits` or `trail`.
  - Adversary request twin: the ghost body differs only by its chosen target.
  - Combat: a ghost on two players, per-player grace and latch, knockback never onto another explorer, deterministic target choice, and **a lethal hit on A mid-tick still lets the remaining ghosts step and hit-check B** (covers all three early-return sites).
- The per-viewer leak test passes.

**Effort.** About 30-50 days. 4.4 is XL and is the largest behaviour change.

**Dependencies.** Phase 2, plus the snapshot v2 migration.

**Risks.**
- Balance shifts (alert and pack behaviour).
- Roughly 33 `game.pos/trail/health/graceTicks/won/lost` reads across `adversary/*.js` and `dungeon.js` (from a code reader's count, not re-counted).
- Spawn fairness.

### Phase 5. Later options

- Opt-in `KnownWorld.visibleExplorers()` returning `{id, pos, distance}` only, for players inside `SIGHT_RANGE` plus LOS. Never health, memory, sentiment, trail or light. Other explorers are non-threat entities in `situation()` as a separate sentence-only `others` list, never in `tacticFeasibility`. It needs visibility twin tests and must land with its tests.
- Co-op ruleset and shared findings. This needs its own leak analysis and design review.
- Optional `rng` state object refactor.
- Replays (start snapshot plus moves plus recorded answers, driven by stubs only), cold storage tiering, rollups and handle history, when there is a use case.

## 9. API surface

```
POST   /v1/auth/session                     create session (OIDC callback)
POST   /v1/games                            {spec} -> {id}            rate-limited
GET    /v1/games/:id                        summary (member only)
POST   /v1/games/:id/players                {agentVersionId, keyId} -> {parId}   join
DELETE /v1/games/:id/players/:parId         leave
POST   /v1/games/:id/control                {action: start|pause|resume}
GET    /v1/games/:id/events                 SSE: view | tick | notice, id = tick number
GET    /v1/games/:id/players/:parId/memory  owner or admin only
POST   /v1/keys, GET /v1/keys               returns {id,label,last4,status} only
POST   /v1/agents, GET /v1/agents ...       versioned
GET    /v1/admin/...                        omniscient view, call log, usage
```

- Everything is versioned under `/v1`. SSE payloads carry `schema`. SSE event ids are the tick number.
- The browser sends no step requests. Its only controls are pause, resume and speed.
- The `STATIC` whitelist is kept (rule 5). New files in `public/` must be registered there.

## 10. Per-viewer view rules

`publicView` (`dungeon.js:358-375`) and `Run.view()` (`turn.js:46-58`) are today's leak surface. **Every field gets a ruling.** Fields marked "re-read" must be confirmed against `dungeon.js:358-375` when 1.9 starts, because the tree is dirty.

| Field | Where | Ruling |
|---|---|---|
| `tiles` | `publicView` | Removed from the default view. Admin Reveal only. |
| `treasure` | `publicView` | Only once lit (`seenTreasure()` semantics). `null` otherwise. |
| `seed` | `publicView` | Removed. Race seeds especially. |
| `props` | `dungeon.js:362` | Projected to lit cells only. Solid props sit on `#` cells and the renderer indexes them by cell (`app.js:273,280`), so the full list outlines the unlit layout. |
| `decor` | `dungeon.js:363` | Projected to lit cells only. |
| `explored_pct` | `dungeon.js:373` (`exploredPct`, `:351-353`) | Dropped. It is `knownFloor / floorCount`, which reveals map size, the leak AGENTS.md already avoids for Jev. Replaced by a known-floor **count**. |
| `width`, `height` | `publicView` | The renderer needs them for buffers. Send a padded bounding box of the known region plus the view margin, not the true map size. If a fixed-size buffer is needed, document the leak as accepted for the player's own game and reject it for competitive games. |
| `start` | `dungeon.js` (re-read) | Own start only, or the known start cell. |
| `light` (full grid), `visits` | `publicView` (re-read) | Own state only. Full grid on connect or resume, then lit-cell deltas `[x,y,light]`. |
| own `pos`, `steps`, `health`, `max_health`, `grace_ticks`, `trail` | | Sent. |
| adversaries | `turn.js:48-52` | Only those currently visible (`seesExplorer`). The full list with `brain` state is admin only. |
| memory | `/api/state` (`server.js:36,82`) | Owner or admin only. |

Further rules:

- A full lit grid is sent only on connect or resume.
- It never contains an unlit treasure, hidden adversaries, `seed`, or another player's state.
- Adversary `brain` state (`objective`, `latest_action`, `last_reason`) is admin-only. Decision probabilities and options are visible to the owner only.
- Spectators of a competitive game get a fogged view delayed N ticks, with no private memory.
- `check-views.mjs` scrambles hidden tiles, props, decor, treasure and adversaries, and requires byte-identical views.

## 11. Retention

| Data | Hot | Delete |
|---|---|---|
| `game_state` | while running or paused | 30 d after finish |
| `game_snapshots` | 7 d | 90 d free, 1 y paid. Keep first, last and every 25th tick. |
| `events` | 30 d | 1 y |
| `jev_calls` | 14 d full | null out `request_body` and `answers` unless the owner opted in. Metadata 13 months. |
| `api_keys` | active | revoked: purge ciphertext after 30 d, keep `fingerprint` and `last4` |
| accounts and players | | On deletion erase email, handle and display name within 30 d. Keep ledger rows with PII removed. |

A nightly job prunes by these windows. It never touches `running` or `paused` games. Partitioning, object-store tiering, `usage_rollups` and `replays` retention are added when those features land.

## 12. Security and prompt-injection rules

- Persona is selected from a server-defined enum or template in competitive games. Free text is allowed only in single-owner private games.
- Free text goes only into `memory.objective` (400) or `profile_note` (200), after control-character stripping and `validateMemory` limits. The other limits are findings 12, tried 5, fact 200, thought 60 and history 5.
- Never place player-controlled text in `RULES` or `questions`, or where it can name a move key. Option keys stay code-generated.
- Never put display names or another player's data in any player's `state` or in adversary `state`.
- Jev's output is a typed Choice or Noul, so injected text can at most bias a choice.
- Any new memory field reaches Jev verbatim, so it must be fog-safe and fit the validation limits (`memory.js:26-35`).
- No route accepts a bare `gameId` without a session.
- Third-party disclosure: memory, persona text and situation text are sent to TypeSafe. State it in the product terms, and cover BYOK data-processing terms.

## 13. What NOT to do

- Do not add Redis in v1, or move to multi-process before a measured need.
- Do not let any code path construct a real Jev asker outside the gateway. Do not read `JEV_API_KEY` outside it.
- Do not run server-side autoplay without the kill switch, the daily post cap and per-game limits in place.
- Do not hit `/api/step`, press Start, or pass `--live` to test anything. Always inject stub `ask` and `decide`, and install the fetch tripwire in every script (including `check-props.mjs`).
- Do not JSON-clone, spread or `structuredClone` a `Game` or an `Adversary`. Do not add public fields to `Adversary` (rule 4).
- Do not add or reorder `rng()` calls in `generateDungeon` or `spawnAdversaries`. Change `SPAWN_STEPS` (`dungeon.js:16`) and `MIN_SPAWN_STEPS` together (rule 8).
- Do not add any relative import to `dungeon.js` beyond the single `placeProps` import.
- Do not hold a `Game` in explorer code. Do not import `store/` or `runtime/` from explorer files.
- Do not persist or send a cross-player merged light map.
- Do not rename `Run` or reuse `run_` as a DB prefix.
- Do not let persona text edit `RULES` or reach hidden state.
- Do not regenerate a dungeon from seed after a generator change. Pin the dungeon or fail loudly.
- Do not silently fall back to code when a budget is hit. Pause and say why.
- Do not use `legal[0]` as the explorer fallback.
- Do not split `takeTurn` into plan/commit. Use brain snapshot and restore for deadline misses.
- Do not hand-edit runtime output (`memory.json`, `memory.md`, `adversaries.json`) (rule 7). After the cutover, memory lives in the DB and is read through the admin API.
- Do not commit or edit other sessions' uncommitted work. Check `git status` before starting each phase.
- Do not expose the service publicly before Phase 2 is complete, including its transport hardening.

## 14. Open questions for the user

1. **Hedge billing.** Does TypeSafe bill an aborted hedge copy, and does it support per-key quotas? This sets the default hedge and the cap math. Until answered, count conservatively and default to hedge 1.
2. **Key model.** BYOK-only, or platform credits with a free allowance? What size is the allowance, and is BYOK required beyond it?
3. **Shared-world win rule.** Race (recommended first) or co-op? Needed before Phase 4.
4. **Ghost billing in shared worlds.** Target pays with per-game caps, or the game owner or a pool pays? Private games are unaffected.
5. **Deploy policy for rules changes.** Drain on a `rules_version` change (default), or run old engine builds side by side?
6. **Dungeon pinning.** Pin the dungeon blob for in-flight games (recommended), or regenerate from seed?
7. **Spectators.** May they see agent thoughts? Default is no.
8. **Reveal.** Confirm it is disabled in competitive games and admin-only elsewhere.
9. **Dependency policy.** Confirm that adding `pg` and a migration tool ends the zero-dependency convention.
10. **File ownership.** Phases 0 and 1 touch files owned by the world, brain, adversary and UI agents. Do you authorise the cross-role edits (rule 9)?
11. **Deadline numbers.** After the staging latency run, which `tickMs` floor and deadline `D` do you want? (The decision-tick policy itself is settled: fall back now and re-ask next tick.)
12. **Constants drift.** Which values are intended: code (`ADVERSARY_SPEED = 0.6`, `MAX_SEARCH_TICKS = 18`, `MAX_ADVERSARIES = 12`) or AGENTS.md (0.5, 12, 8)? The code is treated as authoritative until you say otherwise.
13. **Platform spend ceiling.** What daily post cap should `JD_DAILY_POST_CAP` start at, and who may flip `JD_JEV_LIVE`?
14. **Viewer width/height.** Is a padded bounding box acceptable for private games, and must competitive games hide true map size entirely?
15. **Staging latency run.** Do you authorise one budget-capped live run to measure Jev p50/p95? It is the only paid step this plan requires before Phase 1 exits.

## 15. Phase summary

| Phase | Theme | Effort | Depends on | Gate |
|---|---|---|---|---|
| 0 | Foundations, paid-path closure, no-egress CI | 20-25 d | none | all existing checks, `check-persistence.mjs` and `check-paid-paths.mjs` green in CI |
| 1 | Persistence, private multi-game, cost guard | 30-38 d | 0 | `check-runtime.mjs`, `check-views.mjs` green, latency numbers recorded |
| 2 | Auth, agents, BYOK, quotas, transport hardening, races | 38-44 d | 1 | authz, transport, gateway, key-canary, injection and race tests |
| 3 | Cloud deploy, ops, scale readiness | 12-18 d | 2 | CI with no network, restore and drain tests |
| 4 | Shared-world race | 30-50 d | 2, decisions 3 and 4 | multi-explorer twin and combat tests |
| 5 | Visibility, co-op, replays, polish | open | 4 | own design reviews |

Phases 0 to 3 give hosted, concurrent, durable, authenticated and fog-safe multiplayer. They change **no adversary targeting or balance logic**, but they do make small adversary-code edits (the deadline race in 1.6, injected `rand` and `decide` becoming required, `serialize`/`restore`) and they change Jev's option order (shuffle streams). Where a per-tick cap binds, capped ghosts take the code fallback, which counts as accepted behaviour drift and is surfaced as an event. Phase 4 is the only phase that changes adversary targeting.

## 16. Caveats

- Line numbers cite the dirty working tree and may drift.
- This revision re-read the code for these citations: `adversary.js:14,16,19-21,23-24,312,334,344,349,358,369-375,382`; `explorer/brain.js:26,34,143,176,193-194,199,211-212,252,259,270,280,295,324,335,338,348,356,390`; `adversary/brain.js:44,234`; `jev.js:4-6,17,19,24,30,41`; `dungeon.js:308-311,358-363,373`; `check-dungeon.mjs:97`; `turn.js:44-58`; `.gitignore`; and `git ls-files`. Citations not in that list are carried over from earlier sections and were not re-read.
- The CPU, billing and latency claims are inferences. Each has a test or measurement step above.
- The third-party harness flagged an instruction-shaped pattern in the earlier plan text. It was the benign SSE line `id=<\tick>` in section 9. No directive was embedded and none was followed. It is now written as "id = tick number".

## Review changes (appendix)

**Blocker fixed**
- Cost guard moved into Phase 1 (task 1.1): the `JD_JEV_LIVE` kill switch, a platform-wide daily post cap, per-game max ticks and posts, pause-on-cap, and autoplay off by default. Server-side ticking no longer arrives before its spend controls.

**Major fixed**
- Paid-path bypass closed (Phase 0, task 0.3): `ask` and `decide` are required in both brains, `jev.js` takes `apiKey` explicitly, only the gateway builds real askers, and `check-paid-paths.mjs` greps for `askJev(`.
- TLS, proxy handling, security headers and CORS moved from Phase 3.6 to Phase 2.3, with a transport exit test. The internet gate now includes them.
- The no-egress CI moved from Phase 3 to Phase 0 (0.2). The tripwire is added to `check-props.mjs` (0.1).
- The plan/commit split of `takeTurn` is dropped. Deadline misses use a pre-turn brain snapshot, then restore, then `fallbackMove`, with `pending` kept so the decision is re-asked. The rationale is in section 3, citing `brain.js:211,212,280,393`. Task 0.8 is gone.
- The tick-timing contradiction is fixed. `tickMs` is a floor, `D` is derived from it, and the numbers are placeholders until a budget-capped staging latency run.
- The section 10 ruling table now covers every `publicView` field, including `props`, `decor`, `explored_pct`, `width`/`height` and `seed`, and `check-views.mjs` scrambles hidden props.
- Phase 4.4 lists all three early-return sites (`adversary.js:344,349,382-384`), the `Game.damage` no-op under a shared latch, and a combat test for a lethal hit on A mid-tick.
- `MAX_ADVERSARIES = 12`, `ALERT_STEPS` and the ghost-load formula are in section 2.2, in `games.constants`, and in the cap sizing. The earlier "8 posts per tick" default is replaced by a formula, and the deadline race edits to `adversary.js` are acknowledged in section 15.

**Minor fixed**
- Error classification (transient, auth, budget) added in 1.7, with pause on auth failure and per-actor try/catch isolation in 1.2.
- The forced move is stated as fact (`dungeon.js:308-311`, `brain.js:193-194`). Task 0.11 now decides what to do with the dead branches, and the AGENTS.md cost lines are in the doc sync.
- Light derivability is stated as proven (`dungeon.js:197-218`), kept only as a regression test, and removed from the risk lists.
- The `a10` ordering note is deleted. The sort is already numeric (`adversary.js:334,348`), and a check for it is added.
- The `git ls-files` and `.gitignore` step is dropped, because the files are already ignored and untracked.
- Citations corrected: `check-dungeon.mjs:97`, `adversary.js:334,348`, `adversary.js:369-372`. The stale grace comment (`adversary.js:19`) and the "6 ticks later" claim are added to the doc sync.
- Shuffle `rand` is now injected through opts, and both twin suites are updated together. Server seeds use `crypto.randomInt`.
- Parallel-seed races use server-secret, single-use seeds withheld until the race ends (2.12).
- Over-engineering trimmed for Phases 1-2: no partitioning, KMS, handle history, rollups, replay engine, object-store tiering, or the separate `ticks`, `explorer_state` and `adversary_state` tables. One hot JSONB row per game replaces them.

**Missing list addressed**
- A global kill switch and daily spend cap from Phase 1 (1.1).
- `ask` and `decide` required (0.3).
- A per-user SSE connection cap and slow-client backpressure (1.9, 2.9).
- Disclosure and consent about what TypeSafe receives (6.1, 12).
- Error classification and pause-on-auth (1.7).
- A measured latency distribution before fixing `D` and `tickMs` (Phase 1 exit, open question 15).
- Per-game error isolation in the actor (1.2).
- A ruling for every `publicView` field (section 10).
- Phase 4 early-return sites and the `Game.damage` latch (4.4).

**Added open questions:** 13 (platform spend ceiling), 14 (viewer width and height), 15 (staging latency run). Question 11 now covers only the deadline numbers.