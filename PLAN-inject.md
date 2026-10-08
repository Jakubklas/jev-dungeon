# PLAN-inject: the player whispers a thought to the explorer

Status: **I1-I4 built (uncommitted until the user commits); I5 (behaviour measurement) open.** Approved: 20 steps, top priority with safety kept, Jev-judged early end, cooldown 10 s, 140 chars. Code wins over plans; AGENTS.md has the current description.

### Results (I4)
- Checks green: check-inject, check-inject-api (incl. a stubbed `Run` over 24 steps: `turn.directive` and `view().directive` count 19..0, expire, approach resumes, no `plan.tried` row; HTTP 400/403/409/429/200), check-request-hashes unchanged, check-dungeon bounds unchanged.
- Size: a 140-char directive adds about 131 B to an ordinary tick request (3309 -> 3440 B) and about 130 B to the sentiment request; `directive_done` adds one small Noul every 5 steps on ordinary ticks only.
- Fixed in review: on expiry the parked approach was not reset (the getter was already null); a stale review fired the step after.
- `directive_done` is asked every 5 steps (`DIRECTIVE_ASK_EVERY`), above 0.5 ends it.

## Bottom line

A text box under the board lets the player send the explorer one short instruction ("go for the coins in the east room", "stay away from ghosts"). The server keeps it as a **directive** with a lifetime. While it is live, every explorer request carries it as the top priority and as the stated objective, so Jev's `next_move`, `tactic`, `skill` and approach answers follow it. It expires on its own (or when the player clears it or replaces it). Hard game rules and the fog of war do not change.

## Design

### Input and limits
- One text field + Send button (Enter sends; Shift+Enter is not needed, single line). `maxlength` 140 chars, enforced in the UI **and** the server (never trust the browser).
- Cooldown: one injection per `injectCooldown` (default 10 s of wall clock). The server rejects early ones with **429** and the UI shows a countdown on the button. A new accepted injection **replaces** the live one (no stack, so context cannot grow).
- Sanitising: trim, collapse whitespace/newlines, strip control chars. Empty text = clear the directive.

### Lifetime ("for a while, or until relevant")
- Lives in **game steps**, not seconds: `injectSteps` (default 20 steps). Reason: a step's wall time depends on Jev latency, and step counts keep the checks deterministic and free. (UI can show "~20 steps left"; see open question 1.)
- Ends earlier when: the player sends an empty/clear; a new directive replaces it; the game ends; **optionally** the explorer reports it done (see below).
- "Until relevant" (stretch, phase I4): add a cheap Noul `directive_done` question to the existing review tick (never a new call): above 0.5 the directive is dropped. Off in I1-I3.

### What Jev reads
New plain-JSON field, fog-safe because it is the player's own text, not world state:
`state.directive = { text, steps_left, from_step }` (absent when none).
- `game.rules()` gets one sentence only while a directive is live: "The player has given you an instruction in `directive`. Follow it above your own plan; it replaces your current objective for as many steps as it says."
- `next_move` and `tactic` priorities: first line becomes `Follow the player's directive: "<text>". It outranks the mood and the approach. Never step onto an adversary.` The safety line stays; the mood priority and "avoid backtracking / reveal new cells" lines are dropped while it is live (same trick as the engage move questions).
- `skill` question: directive line included, so "attack ghosts" / "never fight" is respected.
- The text is quoted and labelled as the player's words (prompt-injection hygiene, and so Jev treats it as an objective, not as game rules).
- **Drops the other objective:** while live, `plan.approach` is shown as parked (`interrupted`-style) and the review/`leave_now`/coin-decision questions are not asked, so Jev is not pulled two ways. On expiry the parked approach resumes (reuse `interruptApproach` / resume path; no `plan.tried` row, like a tactic).
- Mood: no forced mood. The directive text is also the tie-break for the sentiment question ("`directive` outranks every mood's `when`").
- Triggers: a new directive queues one `directive` decision (a sentiment call merged under the existing merge rule: one call, not two) so the tactic/mood reacts at once.
- Request size: ~+180 B with a 140-char directive. `check-dungeon.mjs` bounds (9500 / 10500) must be re-measured; remove the equivalent bytes elsewhere if over.

### Memory and UI
- `memory.directive` (validated in `memory.js`, `LIMITS.directive` 140) = `{ text, from_step, until_step }` or `null`; `events` logs "Heard: <text>" and "Directive ended: reason". Keeps `memory.json` the source of truth; the explorer's `#state` picks from it.
- Pane shows the live directive with a step countdown and a clear button; the log gets a line when it is sent / ends.
- The browser never sees more than it sent; the step response carries `turn.directive` for the countdown.

### Server API
- `POST /api/inject` `{ text }` -> `200 { directive }`, `400` bad/too long text, `409` no game / game over, `429` cooldown (with `retry_in_ms`). Runs between steps: if a step is in flight, the directive is stored and applies from the **next** step (no race with `takeTurn`).
- `DELETE`-style clearing via `POST /api/inject { text: '' }`. All paths relative in the page (hub prefix rule).
- Settings (new "Player" group in `src/settings.js`, `when: 'live'`/`'next'`): `injectMaxChars` 140, `injectSteps` 20, `injectCooldownS` 10, `injectEnabled` true. No costs: injecting calls no Jev; only the following steps do (the same as today).

### Hard rules kept
- Fog of war: nothing from the world enters the directive; it is the player's text. The static guard allowlist is unchanged because the directive arrives via the brain's public API (`brain.setDirective(text, { steps })`), not via a `Game`.
- A touch is a bump, lives, grace: untouched. A directive cannot disable the "never step onto an adversary" line.
- No `rng()` change; seeds stay deterministic. With no directive, requests are **byte-identical** (`check-request-hashes.mjs` must pass unchanged).
- New `public/` files (if any) go in `server.js` `STATIC`. Prefer editing existing `index.html` / `app.js` / `style.css`.

## Phases / tasks

| # | Task | Owner files | Done when |
| --- | --- | --- | --- |
| I1 | **Brain core**: `setDirective` / `clearDirective` / expiry in `ExplorerBrain`; `memory.directive` + validation; `state.directive`; rules sentence; priorities in `next_move`, `tactic`, `skill`; parked approach; `directive` trigger; no review/leave_now/coin questions while live | `src/characters/explorer/brain.js`, `memory.js`, `perception.js` (if text helpers) | stub-Jev checks: request carries the directive, absent => request-hash fixture unchanged, expiry resumes the approach, size bounds hold |
| I2 | **Server + settings**: `/api/inject`, validation, cooldown, step-in-flight handling, `Run` passthrough, settings group, `view()` / `turn.directive` | `server.js`, `src/turn.js`, `src/settings.js` | HTTP checks: 400 / 409 / 429 / 200, limit enforced server-side, queued during a step |
| I3 | **UI**: input + counter + Send/Enter, cooldown countdown, live-directive chip with steps left and Clear, log lines, error states, mobile layout | `public/index.html`, `app.js`, `style.css` | headless-Chrome screenshot; manual: send, replace, clear, cooldown |
| I4 | **Checks + docs**: `scripts/check-inject.mjs` (twin: a directive never leaks world state; clamping; expiry; merge rule: one sentiment call), update AGENTS.md / CONTRACT.md; optional `directive_done` question | `scripts/`, docs | all `check-*.mjs` green, `check-request-hashes` unchanged |
| I5 | **Behaviour measurement (free)**: dry run with a stub Jev that reads the directive; then, **only if the user asks**, a short live run to see whether real Jev obeys | `scripts/measure-memory.mjs` or a new script | report in this file |

Order: I1 -> I2 (parallel with I3 once the API shape above is fixed) -> I4 -> I5. I1 and I2/I3 touch disjoint files, so they can run as parallel agents; I4 follows. Only I5's live run spends money.

## Open questions (defaults in brackets)
1. Lifetime in **game steps** [20] or wall-clock **seconds** [20 s]? Seconds are friendlier to read but make the game depend on API latency.
2. How hard does it override? [Top priority, replaces approach/mood; "never step onto an adversary" and the rules stay] vs [truly everything, even lives].
3. Cooldown [10 s] and max chars [140]?
4. "Until relevant" via the Jev `directive_done` check [yes, phase I4 stretch] or skip?
