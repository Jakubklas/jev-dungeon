# PLAN: one central config for everything

**Bottom line.** Replace the 40 knobs in `src/settings.js` plus roughly 200 hard-coded constants with one YAML file, `central-config.yaml`, backed by a single typed registry in `src/config/`. Every module reads its numbers through that registry (or through the existing `configureX` hooks), so the file controls the world, props, skills, kinds, characters, moods, thresholds, prompt limits, and the Jev client. Do it in 8 phases; each phase leaves every check green and the default request hashes byte-identical. Recommended format: YAML through the one `yaml` npm package, because it keeps comments when the settings page writes back, which JSON cannot.

Status: **P0 is built** (registry with the 39 existing knobs, YAML loader and layers, `userSetting` flag and `/api/config?scope=user`, `scripts/config.mjs`, `scripts/check-config.mjs`, migration of the earlier JSON file). P1 to P7 are not started. It replaced the JSON layer (`central-settings.json`).

## 1. Decisions (settled)

| # | Decision | Outcome |
| --- | --- | --- |
| D1 | YAML parser | **Use the `yaml` npm package** (pure JS, no transitive deps). First dependency of the project; it also gives comment-preserving writes. |
| D2 | Prompt wording editable? | **Yes, in two steps.** Moods (`when`, `note`, priority lines) and character styles are plain data and move in P3/P2. Rules text, question text and trigger text are the opt-in `prompts:` section in P6, validated for placeholders. |
| D3 | Live vs next game | Keep the flag per knob (`live` or `next`). |
| D4 | One file or one per instance | Keep today's layers: defaults < file < `instances.<arena\|gym\|arena/a1>` < the instance's own sparse overrides. |
| D5 | What stays out of the file | **Secrets** (`JEV_API_KEY` stays in `../.env`), ports and bind address (hub env vars), and the fixed rules other code assumes (directions, cell format). Nothing else. |
| D6 | Settings page | **The central file is not shown on the settings page.** The existing `/settings` page keeps working as it does today (a shim over the registry). A later UI shows only knobs flagged `userSetting` (section 2b). |

## 2. What the file looks like

Sections follow the game's own nouns, not the old settings-page groups. Every key has a one-line comment, written by the registry when it creates the file and preserved on every later write.

```yaml
# central-config.yaml  (layers: defaults < this file < instances.<name> < the instance's own overrides)
world:
  size:        { min: 25, max: 90 }          # map side range, cells
  roomArea:    290                           # map cells per room (lower = more, closer rooms)
  rooms:       { min: 4, max: 15 }           # room width/height range
  lightRadius: 7                             # cells each visited cell lights up
  sightRange:  7                             # how far anyone sees along a clear line
  props:
    torchesPerRoom: { min: 1 }
    kinds:                                   # catalog: availability and weight per prop kind
      crates:  { enabled: true, weight: 3 }
      forge:   { enabled: true, weight: 1, shapes: [[2,2],[2,3],[3,2]] }
  coins:  { floorPerCoin: 60, max: 30, dropChance: 0.6 }
  hearts: { roomsPerHeart: 4, max: 6 }

explorer:
  lives: 2
  graceTicks: 4
  skills: [sword_strike, shield_block]       # availability, max 4
  brain:                                     # was 28 constants in brain.js
    reviewEvery: 8
    rememberSteps: 30
    holdMax: 5
    coinNear: 8
  confidence:                                # was 32 constants in confidence.js
    start: 50
    deltas: { hit: -7, struck: 5, dispelled: 8, blocked: 3, evaded: 2, pressed: -1 }
    tiers:  { lowMax: 35, highMin: 70, hysteresis: 5 }
    panic:  { enter: 20, exit: 25 }
    regen:  { rate: 0.25, wait: 10 }
  moods:                                     # was SENTIMENTS in brain.js
    wary:   { minGap: 4, endTicks: 5, tier: low,  when: "...", note: "..." }
    bold:   { minGap: 2, endTicks: 1, tier: [mid, high], when: "...", note: "..." }

skills:                                      # was loadouts.js + settings Skills group
  sword_strike: { kind: attack, damage: 1, cooldown: 1, shape: [[1,0]] }
  shield_block: { kind: block,  effectiveness: 0.6, cooldown: 2 }
  claw_strike:  { kind: attack, damage: 1, cooldown: 2 }
  stunTicks: 2

monsters:
  global: { speed: 0.6, chaseRange: 7, maxSearchTicks: 18, packAlert: true, alertSteps: 24 }
  spawn:  { floorPerMonster: 150, max: 12 }
  kinds:
    ghost: { weight: 0.75, hp: 2, skills: [claw_strike], speed: 1 }
    troll: { weight: 0.25, hp: 4, skills: [claw_strike], speed: 0.65, skillTuning: { claw_strike: { damage: 2 } } }
  characters:
    enabled: false
    mix: mixed                               # mixed | standard | { aggressive: 3, timid: 1 }
    presets:
      aggressive: { aggression: 3, persistence: 2, horizon: 1, roaming: 2, pack: 2, style: "..." }
    traitTable:                              # was TABLE in character.js: trait level -> number
      chaseRange: { trait: aggression, levels: [5, 7, 7] }

limits:                                      # prompt and memory limits, was LIMITS in two memory.js files + FACT_MAX
  explorerMemory: { events: 6, eventText: 200, landmarks: 8, tried: 5 }
  requestBytes:   { chasing: 9500, patrolling: 10500 }   # asserted by check-dungeon, now read from here

jev:
  model: jev-latest
  hedgeDelayMs: 800
  retries: 3
  timeoutMs: 20000
  retryStatus: [429, 502, 503, 504, 529]

ui:                                          # served at /api/config, read by app.js
  tweenMs: 150
  walkMs: 620
  thoughts: { troll: [...], ghost: [...] }  # bubble lines

instances:
  arena: { explorer: { lives: 4 }, skills: { stunTicks: 0 } }
  gym:   { world: { size: { min: 37 } } }
```

## 2b. The `userSetting` flag (what a player may touch)

Every registry **category** (a top-level section or a sub-section such as `world.props`, `explorer.confidence`, `monsters.kinds`) carries a boolean `userSetting`. A key inherits its category's value and may override it. The flag lives in the registry (code), not in the YAML, so editing the file cannot widen what a UI exposes. It does not limit the file: the file controls everything; the flag only decides what a future player-facing UI lists.

```js
// registry.js (excerpt)
category('world',               { userSetting: false, doc: 'Dungeon layout, props, light. Developer only.' });
category('world.coins',         { userSetting: false });
category('explorer',            { userSetting: true,  doc: 'The knight: lives and loadout.' });
knob('explorer.lives',          { type: 'int', min: 1, max: 9, default: 2, when: 'next' });
knob('explorer.brain.reviewEvery', { userSetting: false, ... });   // key-level override
category('player',              { userSetting: true,  doc: 'Directives to the explorer.' });
category('monsters.global',     { userSetting: false });
category('jev',                 { userSetting: false });
category('limits',              { userSetting: false });
category('prompts',             { userSetting: false });
```

- **Default is `false`.** A new category or knob is hidden from players until someone sets it, so a forgotten flag fails safe.
- **Proposed starting values** (please confirm): `true` for `player.*` (directive length, lifetime, cooldown), `explorer.lives`, and `skills` cooldown/damage of the explorer's own loadout is **false**. Everything else `false`: `world`, `monsters`, `explorer.brain`, `explorer.confidence`, `explorer.moods`, `limits`, `jev`, `prompts`, `ui`, `testbed`.
- **API.** `GET /api/config?scope=user` returns only flagged knobs (schema plus values); `POST` with `scope=user` rejects any other key with 403. `GET /api/config` (no scope) is for tools and the CLI (`scripts/config.mjs`) and is not linked from the page.
- **Check.** `check-config.mjs` asserts the flag exists on every category, that unflagged knobs never appear in the user scope, and prints the list of user-visible knobs so a change to it shows up in review.

## 3. Architecture

**One registry, three consumers.** `src/config/registry.js` lists every knob once: `{ path, type, min, max, step, enum, default, when: live|next, doc, group }`. From it we generate (a) the default file with comments, (b) validation, (c) the existing settings page's schema (today `SCHEMA` in `settings.js`, which becomes a thin view over the registry; the page does not show the new central sections), and the `userSetting` filter, and (d) a generated reference table in the docs.

**Modules.**

| File | Role |
| --- | --- |
| `src/config/registry.js` | The knob list (data only, no imports). The single source of truth for defaults. |
| `src/config/load.js` | Reads YAML, applies the layers, validates, cross-field rules (`size.min <= size.max`, `tiers.lowMax < highMin`, `panic.exit >= panic.enter`, kind weights not all 0), returns `{ values, warnings }`. Keeps the last good config on a parse error. |
| `src/config/runtime.js` | Holds the live and applied values, mtime watch (the `refresh()` we have now), `applyNextGame()`, and a `subscribe` that pushes values into modules. |
| `src/config/write.js` | Comment-preserving writes through the `yaml` Document API (settings page saves, `scripts/config.mjs set a.b.c value`). |
| `src/settings.js` | Shrinks to a compatibility shim over `runtime.js` so `server.js`, `hub.js` and the page keep working while modules migrate. |
| `scripts/config.mjs` | CLI: `init`, `get`, `set`, `validate`, `diff` (vs defaults), `docs`. |

**How modules read values (this is where the fog-of-war rule bites).** The static guard in `check-dungeon.mjs` section 0 limits what `src/characters/explorer/*` may import. So explorer and adversary perception code must not import the loader. Use the pattern the project already has: each module keeps its constants as `let` values with defaults equal to today's, and exports `configureX(values)`. `runtime.js` calls every `configureX` on load and on refresh. For explorer files add one pure module, `explorer/tuning.js` (imports nothing, like `confidence.js` today), with a `configureTuning()` hook, and list it in the guard's allowlist. Modules never see the config object, only the numbers they were handed.

**Structured data, not just numbers.** Skills, kinds, props and moods are registries of objects today (`LOADOUTS`, `KINDS`, `SENTIMENTS`, `PRESETS`, props `catalog.js`). They become "base data plus overrides from the file": the code's table stays as the default, the file can change any field and nothing else: new kinds, skills and characters are added in code, never from the file.

## 4. Inventory: what moves, and where it touches the code

Counts are top-level UPPER_SNAKE constants found in the survey.

| Area | Today | Moves to | Files touched | Mode |
| --- | --- | --- | --- | --- |
| World and layout | `dungeon.js` (12): sizes, room sizes, `ROOM_AREA`, light, sight, spawn distance | `world.*` | `dungeon.js` | next |
| Props | `props/catalog.js` (29): kinds, shapes, `TORCH_MIN`; `props/place.js` | `world.props.*` | `props/*`, `testbed.js` | next |
| Coins, hearts | `coins.js`, `hearts.js` | `world.coins/hearts` | already have `configureX` | next |
| Testbed defaults | `testbed.js` `DEFAULTS` (8) | `testbed.*` | `testbed.js` | next |
| Skills | `loadouts.js`, `skills/config.js`, `attack.js` shapes, `question.js` `SKILL_MIN`, `MAX_SKILLS` | `skills.*`, `explorer.skills`, `monsters.kinds.*.skills` | `skills/*`, `kinds.js`, `testbed.js` | next |
| Monster kinds | `kinds.js`, trollShare, ghostHp, trollHp (settings) | `monsters.kinds.*` | `kinds.js`, `adversary.js` | next |
| Characters | `character.js` (14): presets, `TABLE`, line tables | `monsters.characters.*` | `character.js`, `adversary/brain.js` | next |
| Adversary behaviour | `adversary.js` (13), `adversary/brain.js`, `perception.js`, `memory.js` limits | `monsters.*`, `limits.adversaryMemory` | those files | live/next |
| Explorer brain | `brain.js` (28): review cadence, cooldowns, hold, coin and heart ranges | `explorer.brain.*` | `brain.js` | live |
| Confidence, moods, thresholds | `confidence.js` (32), `SENTIMENTS`, `TIER_MOODS`, `BANDS` | `explorer.confidence.*`, `explorer.moods.*` | `confidence.js`, `brain.js`, `memory.js` (`MOOD_IDS`) | live |
| Perception and encounter | `perception.js` (14), `encounter.js` (9), `known-map.js` | `explorer.perception.*` | those files | live |
| Prompt and memory limits | explorer `LIMITS`, adversary `LIMITS`, `FACT_MAX`, request-size bounds in `check-dungeon.mjs` | `limits.*` | `memory.js` x2, `attack.js`, `check-dungeon.mjs` | next |
| Jev client | `jev.js` (6): hedge, retries, timeout, statuses, model | `jev.*` | `jev.js` | live |
| Server and hub | `server.js`, `hub.js` (13) | stay env vars; instance layering stays | none | n/a |
| UI | `public/app.js` (57), `sprites.js`, `STYLE_GUIDELINES.md` | `ui.*` served at `/api/config` | `server.js` route, `app.js` | on load |
| Prompt wording | `rules()` x2, question text, `TRIGGER_TEXT`, `TACTIC_MOVE_HINT`, `LEAD` | `prompts.*` (phase 6, opt-in) | brain files | next |

## 5. Constraints that must hold (each one is a check)

1. **Defaults change nothing.** With no file, behaviour and every request body are identical to today: `check-request-hashes` stays green, `check-dungeon`, `check-adversaries`, `check-skills`, `check-duels` stay green. A new `check-config.mjs` also asserts that each registry default equals the constant it replaced, so a number cannot drift in the move.
2. **Seeds stay deterministic.** Settings that change layout (sizes, room area, prop weights) change the dungeon by design. Nothing may add, remove or reorder `rng()` calls at default values (AGENTS.md rule 8). New streams get their own seeds.
3. **Fog guard unchanged.** No explorer or adversary perception file imports the loader. The static guard allowlist gets only `explorer/tuning.js`.
4. **Checks never read the user's file.** Check scripts load defaults only (`JEV_CONFIG=none`), so a tuned file cannot break a check or the paid-call tripwire.
5. **No silent failure.** A bad key warns with its full path and is skipped; a broken YAML keeps the last good config; the settings page shows the warnings (it already receives `central.warnings`).
6. **Cross-field rules** live in `load.js`, not in modules, and are listed in the generated docs.
7. **A completeness lint.** `check-config.mjs` scans `src/` for top-level numeric or boolean UPPER_SNAKE constants and fails if one is neither in the registry nor in an explicit "fixed on purpose" list (`DIRS`, `STAY`, `ID` regex). That is what keeps "everything is controllable" true after this refactor.

## 6. Phases

Each phase ends with the full check suite green and the hash fixture untouched.

- **P0 Foundation.** Registry, YAML loader, layers, mtime refresh, comment-preserving write, `scripts/config.mjs`. Port the existing 40 knobs, convert `central-settings.json` and the two main instance files to `central-config.yaml`. `settings.js` becomes a shim; the settings page reads its schema from the registry. Ship `check-config.mjs` (defaults equal constants, layering, cross-field, bad-entry warnings).
- **P1 World.** `dungeon.js`, props catalog and weights, coins, hearts, testbed defaults. Verify seeds: `check-dungeon`, `check-testbed`, `check-props`.
- **P2 Skills, kinds, characters.** Make `LOADOUTS`, `DEFAULT_SETS`, kind rows, presets and `TABLE` data with overrides; per-kind claw cooldown and skill lists; availability per side. Verify `check-skills`, `check-kinds`, `check-characters`.
- **P3 Explorer brain, confidence, moods.** Add `explorer/tuning.js`; move `brain.js`, `confidence.js`, `perception.js`, `encounter.js` constants; make mood definitions data with tier membership. Verify `check-confidence*`, `check-duels`, hashes. Mood ids stay a closed set unless `MOOD_IDS` and `TIER_MOODS` are driven from the same section (included here).
- **P4 Adversary behaviour.** `adversary.js`, adversary `brain.js`/`perception.js`/`memory.js`. Verify `check-adversaries`, `measure-memory --who adversary` bounds.
- **P5 Limits.** Both `LIMITS` objects, `FACT_MAX`, and the request-size bounds that `check-dungeon.mjs` asserts (they become config, with the check reading them, so raising a limit on purpose is one edit).
- **P6 Prompts.** Opt-in `prompts:` overrides for mood text, character styles, trigger text, rules text; each template declares its required placeholders and a length cap. Default text stays in code and the hash fixture covers it.
- **P7 Jev client, UI, docs.** `jev.js` knobs; `/api/config` for `app.js` constants (visual only, read at page load); troll and ghost bubble lines move into `ui.thoughts`; generated `CONFIG.md` replaces the settings tables in `AGENTS.md`; AGENTS.md gets the new rule "add a knob = add a registry row".

## 7. Risks and what I would not do

- **Live reload of structural values.** A running game cannot re-shape its map or rebuild its monsters; those are `next` and applied at `POST /api/new`. The page and the file comments say which is which.
- **Foot-guns.** A value can make the game unwinnable or blow the request-size bound. The registry carries hard min/max, and `check-config` validates the shipped examples; it does not try to judge balance.
- **Prompt editing can break fog of war** only if a template pulls in data, so templates take placeholders from a fixed, fog-safe list and nothing else.
- **Stale measure scripts** (`measure-caps`, `calibrate-confidence`) still carry old arms; leave them, note them.
- **Scope.** Rendering art, sprite pixel data and the iso projection stay in code; they are not tunables.

## 8. Decisions after review

1. **Instances override everything.** `instances.<arena|gym|arena/a1>` takes the same shape as the whole file, including `limits` and `prompts`. Cross-field rules run on the merged result per instance.
2. **Monsters and skills are added in code only.** The file tunes existing kinds, skills, characters and moods (stats, weights, availability, text); it cannot define a new kind or skill. An unknown id under `monsters.kinds`, `skills` or `monsters.characters.presets` is a warning and is skipped. A new behaviour class still needs code and a registry row.
3. **`userSetting` starting values** (section 2b) stand unless you change them.

Still open: nothing blocking. P0 can start.
