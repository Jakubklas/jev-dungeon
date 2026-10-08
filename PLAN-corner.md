# PLAN-corner: the explorer must see "I am cornered" and break out

**Problem.** Fleeing the explorer ends in a corner (2-3 walls around it, a ghost between it and the room) and it steps back and forth. The way out is usually to turn round and slip past (rooms are big, ghosts are slower than the explorer: ADVERSARY_SPEED 0.6), or to push through with the sword.

**Diagnosis (hypothesis, verify in the baseline).** Every escape/slip/move rule demands a minimum gap from the enemy (`escapeTarget` tiers, `tacticFeasibility` `gap >= minGap`, the "never step toward an enemy / below your minimum gap" move lines, "do not undo the previous move"). In a pocket those rules forbid every way out, so Jev oscillates between the two least-bad cells; `#bounce` only excludes those two cells.

**Design.** Code detects `cornered` (Jev's spatial reasoning over a grid is weaker than the routes the code already computes). Four arms behind ONE config key `cornerMode`:

| mode | what changes when cornered |
| --- | --- |
| `off` | today's behaviour (baseline, default until the A/B is read) |
| `urgent` | gating relaxed (below) + a short urgent text: "You are cornered (N walls). Do not shuffle in the pocket: get out now, turning round and slipping past is fine, so is fighting through." |
| `ascii` | `urgent` + a small ASCII diagram of the local area (E explorer, G ghost, # wall, . floor, ? unknown) so Jev designs its own route |
| `route` | `urgent` + the computed breakout route in words ("Break out: 4 steps along E,E,N,N; closest approach to the ghost 1 step") and the goal is KEPT for the route's length (like `#keepEscapeGoal`) so it cannot flip each tick |
| `full` | `route` + `ascii` |

Gating relaxed while cornered (all modes except `off`): `slip_past` stays on the menu whatever its gap; `engage` stays when armed; the "never move toward an enemy", "below your minimum gap" and "do not undo the previous move" lines are dropped from the move question; `#bounce` exclusion does not apply to the breakout route.

## Shared interface (the contract between the agents)

`src/characters/explorer/encounter.js` exports `cornerFacts(world, threats)` -> `null | CornerFacts`. `null` = not cornered (also null with no threats).

```
CornerFacts = {
  walls: number,            // orthogonal wall neighbours of the explorer (0..4)
  pocket: number,           // known floor cells reachable from here without entering a cell within 1 step of an enemy
  hasWayOut: boolean,       // pocket contains a frontier cell, the portal, or a cell with >= 3 floor neighbours leading on? (see B's note)
  gap: number,              // nearest enemy distance now (known-path steps)
  breakout: null | {        // best route out of the pocket past/around the enemy
    moves: string[],        // first N moves as direction letters/words in the game's DIRS vocabulary (e.g. ['east','east','north'])
    cells: [x,y][],         // the route cells, first = next cell
    steps: number,
    closest: number,        // closest approach to any enemy along the route (0 = through the enemy cell is NOT allowed, so >= 1)
    through: boolean,       // true when the route passes at closest <= 1 (a slip, may take a claw)
    why: string,            // one sentence for the prompt
  },
  diagram: string[],        // local ASCII window, rows top to bottom, radius 4 around the explorer, legend E G # . ?
  why: string,              // one sentence for the prompt: "Cornered: 3 walls around you, the enemy 3 steps away blocks the room."
}
```

Cornered means: at least one enemy in sight and chasing (or within 3 steps), AND the explorer has >= 2 orthogonal walls (or sits in a pocket of <= 6 safe cells), AND no safe way out (no frontier/portal/open junction reachable keeping a gap of ESCAPE_KEEP_GAP from every enemy). Also true when the brain saw `backAndForth >= 2` in the recent window while an enemy is in sight (the brain passes `{ bounced: true }` as an option; B implements the option).

The brain reads `cornerFacts` once per tick, under `cornerMode !== 'off'`, and passes it into `tacticFeasibility` / the move question / the tactic question. The request-hash goldens must NOT change with `cornerMode: off`.

## Measurement

`scripts/measure-corners.mjs` + `scripts/corner-arenas/corner-*.json` (ASCII testbed maps). Free mode: scripted Jev through `scripts/lib/duel-harness.mjs` (checks structure: detection, gating, route, commitment). `--live`: real Jev headless in-process (no server, no browser, no step delay), capped by `--max-calls`, prints the call count; paid, run only deliberately. Metrics per (arena, placement, seed): escaped within 10 ticks (gap growing AND >= 3 floor exits, or out of the pocket), ticks to escape, A-B-A count, hits taken, Jev calls. `hedgeDelayMs` stays at its default (setting it to 0 doubles every call's cost).

## Rules for agents

- Do NOT commit, stash or revert anything: the working tree holds unrelated uncommitted WIP (skills S4, morale, etc.). A snapshot of src/scripts is at `$CLAUDE_JOB_DIR/tmp/snapshot-pre-corner.tgz`.
- Stay in your files (below). Keep `node scripts/check-*.mjs` green that were green before; report any that were already red.
- No Jev (network) calls except `measure-corners.mjs --live` run by the orchestrator.

| Agent | Files |
| --- | --- |
| A harness | `scripts/measure-corners.mjs`, `scripts/corner-arenas/corner-*.json`, (additive) `scripts/lib/duel-harness.mjs` |
| B detection | `src/characters/explorer/encounter.js` (`cornerFacts` + helpers), `scripts/check-corner.mjs` |
| C integration | `src/characters/explorer/brain.js`, `src/characters/explorer/perception.js`, `src/config/registry.js` + `runtime.js` + `central-config.yaml` + `CONFIG.md` (`cornerMode`), `scripts/check-config.mjs` if needed |
