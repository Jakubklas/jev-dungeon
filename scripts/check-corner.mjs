// Checks for cornerFacts (src/characters/explorer/encounter.js, PLAN-corner): the cornered test, pocket, walls, gap, the
// breakout route, the diagram's fog safety and determinism, over ASCII testbed arenas. No Jev, no network.
// Run from the dungeon-game directory: node scripts/check-corner.mjs

globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newTestGame } from '../src/turn.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { cornerFacts, threatsOf } from '../src/characters/explorer/encounter.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.error('FAIL:', msg); } };
const dir = mkdtempSync(join(tmpdir(), 'corner-'));
const url = pathToFileURL(dir + '/').href;
const ask = async () => ({});
const decide = async () => ({});

// A world from an ASCII map ('@' explorer, 'A' ghosts); ghosts hunt (mode 'chase') unless `patrol`.
function build(map, { patrol = false } = {}) {
  const run = newTestGame({ map, seed: 1 }, { ask, decide, memoryDir: url, dir: url });
  if (!patrol) for (const a of run.game.adversaries) a.mode = 'chase';
  const world = new KnownWorld(run.game);
  return { run, world, threats: threatsOf(world) };
}
const facts = (map, opts, o) => { const b = build(map, opts); return { ...b, f: cornerFacts(b.world, b.threats, o) }; };

// 1. Two-wall corner of a big room, ghost between the explorer and the room: cornered, breakout goes around.
{
  const map = [
    '####################',
    '#@.................#',
    '#..................#',
    '#..................#',
    '#...A..............#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '####################',
  ];
  const { f, world } = facts(map);
  check(f && f.walls === 2, `corner: cornered with 2 walls (${JSON.stringify(f)})`);
  check(f && f.gap === 6, `corner: gap ${f?.gap}`);
  check(f?.breakout && f.breakout.through === false && f.breakout.closest >= 2, `corner: breakout goes around (${JSON.stringify(f?.breakout)})`);
  if (f?.breakout) {
    const b = f.breakout;
    check(b.moves.length === Math.min(b.steps, 8) && b.cells.length === b.steps, 'corner: moves/cells/steps agree');
    check(b.moves.every((m) => ['up', 'down', 'left', 'right'].includes(m)), `corner: DIRS vocabulary (${b.moves})`);
    // Replaying the moves lands on the last cell and never on the ghost.
    let p = [...world.pos];
    const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    for (let i = 0; i < b.moves.length; i++) { p = [p[0] + D[b.moves[i]][0], p[1] + D[b.moves[i]][1]]; check(p[0] === b.cells[i][0] && p[1] === b.cells[i][1], 'corner: moves match cells'); check(world.knownTile(p) === '.' && !(p[0] === 4 && p[1] === 4), 'corner: route on floor, off the ghost'); }
    check(typeof b.why === 'string' && b.why.length > 0, 'corner: breakout why');
  }
  check(f && f.diagram.length === 9 && f.diagram.every((r) => r.length === 9), 'corner: diagram is 9x9');
  check(f && f.diagram[4][4] === 'E' && f.diagram.join('').includes('G'), 'corner: diagram has E in the middle and a G');
  check(f && /^Cornered: 2 walls/.test(f.why), `corner: why text (${f?.why})`);
}

// 2. Alcove with 3 walls, ghost at the mouth-ish: cornered.
{
  const map = [
    '#######',
    '#.....#',
    '#.###.#',
    '#.#@#.#',
    '#.#.#.#',
    '#.....#',
    '#######',
  ];
  // The explorer sits in a 1-wide stub (3 walls: left, right, up) with the ghost two cells below.
  const m = map.map((r) => r.replace('A', '.'));
  m[5] = '#..A..#';
  const { f } = facts(m);
  check(f && f.walls === 3, `alcove: 3 walls (${JSON.stringify(f && { walls: f.walls, pocket: f.pocket })})`);
  check(f && f.gap === 2, `alcove: gap ${f?.gap}`);
}

// 3. Open room centre with the ghost far enough: null.
{
  const map = [
    '#################',
    '#...............#',
    '#...............#',
    '#...............#',
    '#.......@.......#',
    '#...............#',
    '#...............#',
    '#..............A#',
    '#################',
  ];
  check(facts(map).f === null, 'open room: not cornered');
  const near = map.slice(); near[7] = '#...............#'; near[3] = '#......A........#';
  check(facts(near).f === null, 'open room, ghost adjacent-ish in the middle: still not cornered (walls 0, room to run)');
}

// 4. Corridor dead end: cornered, no breakout (cannot step onto the ghost) or a through route.
{
  const map = [
    '###########',
    '#@...A....#',
    '###########',
    '###########',
    '###########',
  ];
  const { f } = facts(map);
  check(f && f.walls === 3, 'dead end: cornered with 3 walls');
  check(f && (f.breakout === null || f.breakout.through === true), `dead end: no way past the ghost (${JSON.stringify(f?.breakout)})`);
}

// 5. Ghost far away and not chasing: null.
{
  const map = [
    '####################',
    '#@.................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#.................A#',
    '####################',
  ];
  check(facts(map, { patrol: true }).f === null, 'far patrolling ghost: null');
  check(facts(map).f === null, 'far chasing ghost with a way to run: null');
  check(cornerFacts(build(map).world, []) === null, 'no threats: null');
  // bounced forces it while an enemy is in sight.
  const b = build(['####################', '#@.................#', '#..................#', '#.....A............#', '#..................#', '####################'], { patrol: true });
  check(cornerFacts(b.world, b.threats) === null, 'patrolling ghost 7 steps away: null');
  const f = cornerFacts(b.world, b.threats, { bounced: true });
  check(f && Array.isArray(f.diagram) && typeof f.why === 'string', 'bounced: cornered with an enemy in sight');
}

// 6. Determinism.
{
  const map = ['####################', '#@.................#', '#..................#', '#...A..............#', '#..................#', '#..................#', '####################'];
  const a = JSON.stringify(facts(map).f), c = JSON.stringify(facts(map).f);
  check(a === c && a !== 'null', 'determinism: identical facts for identical worlds');
}

// 7. Fog: an unlit cell shows '?', and a ghost out of sight is never drawn.
{
  const wide = 40;
  const map = [
    '#'.repeat(wide),
    '#@' + '.'.repeat(wide - 3) + '#',
    '#' + '.'.repeat(wide - 2) + '#',
    '#' + '.'.repeat(wide - 2) + '#',
    '#' + '.'.repeat(wide - 2) + '#',
    '#' + '.'.repeat(wide - 3) + 'A#',
    '#'.repeat(wide),
  ];
  const b = build(map);
  check(b.threats.length === 0, 'fog: far ghost is not visible');
  const corner = facts(['######################', '#@...................#', '#....................#', '#....................#', '#....................#', '#.A..................#', '######################'], {}, { bounced: true });
  check(corner.f && corner.f.diagram.every((r) => r.length === 9), 'fog: diagram size at the map edge');
  // A cell the explorer has not lit must be '?': dim the light of one cell in the window and compare.
  const b2 = build(['######################', '#@...................#', '#....................#', '#....................#', '#.A..................#', '######################']);
  const g = b2.run.game;
  g.light[2][3] = 0; // not lit
  const f2 = cornerFacts(b2.world, b2.threats, { bounced: true });
  // Window: x from -3..5, y from -3..5; cell (3,2) is column 6, row 5.
  check(f2.diagram[5][6] === '?', `fog: unlit cell shows ? (row ${f2.diagram[5]})`);
  // Twin: scrambling the real tile under an unlit cell must not change the diagram.
  const b3 = build(['######################', '#@...................#', '#....................#', '#....................#', '#.A..................#', '######################']);
  b3.run.game.light[2][3] = 0;
  const t = b3.run.game.dungeon.tiles;
  t[2] = t[2].slice(0, 3) + '#' + t[2].slice(4);
  const f3 = cornerFacts(b3.world, b3.threats, { bounced: true });
  check(JSON.stringify(f2) === JSON.stringify(f3), 'fog: a hidden tile change does not change the facts');
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('check-corner: all passed');
