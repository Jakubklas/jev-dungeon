// Sanity checks for the dungeon generator, line of sight and the fog of war.
// Run from the dungeon-game directory: node scripts/check-dungeon.mjs [--measure]
//   --measure  also plays ~10 small and ~10 large maps with a scripted follower (no Jev)
//              and times perception per tick on a 150x150 map.

import {
  generateDungeon, createGame, legalMoves, applyMove, isKnown, rng, hasLineOfSight, floorDistances,
  publicView, DIRS, SIGHT_RANGE, MIN_SIZE, MAX_SIZE,
} from '../src/dungeon.js';
import {
  APPROACHES, TACTICS, isTactic, situation, describeMoves, approachTarget, availableApproaches, treasureSeen,
  tacticFeasibility, tacticOptions, knownLineOfSight,
} from '../src/characters/explorer/perception.js';
import { SENTIMENTS, newRun, takeTurn, setAsker, setMemoryDir } from '../src/characters/explorer/brain.js';
import { validateMemory } from '../src/characters/explorer/memory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { visibleAdversaries, spawnAdversaries } from '../src/characters/adversary/adversary.js';

const MEASURE = process.argv.includes('--measure');
let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures <= 20) console.error('FAIL:', msg);
};
const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const inRoom = (d, [x, y]) => d.rooms.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
// Sight exactly as the contract defines it (independent of adversary.js).
const sees = (dungeon, a, b) => euclid(a, b) <= SIGHT_RANGE && hasLineOfSight(dungeon, a, b);

// 1. Generation: ~200 seeds.
const SEEDS = 200;
let minW = Infinity, maxW = 0, minH = Infinity, maxH = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const d = generateDungeon(seed);
  const { width: W, height: H } = d;
  const tile = ([x, y]) => d.tiles[y]?.[x];
  minW = Math.min(minW, W); maxW = Math.max(maxW, W); minH = Math.min(minH, H); maxH = Math.max(maxH, H);
  if (d.seed !== seed) fail(`seed ${seed}: returned seed ${d.seed}`);
  if (W < MIN_SIZE || W > MAX_SIZE || H < MIN_SIZE || H > MAX_SIZE) fail(`seed ${seed}: size ${W}x${H} out of range`);
  if (d.tiles.length !== H || d.tiles.some((r) => r.length !== W)) fail(`seed ${seed}: tiles do not match ${W}x${H}`);
  if (/\./.test(d.tiles[0] + d.tiles[H - 1]) || d.tiles.some((r) => r[0] === '.' || r[W - 1] === '.')) fail(`seed ${seed}: outer ring is not all wall`);
  if (tile(d.start) !== '.') fail(`seed ${seed}: start is not floor`);
  if (tile(d.treasure) !== '.') fail(`seed ${seed}: treasure is not floor`);
  if (!inRoom(d, d.treasure)) fail(`seed ${seed}: treasure is not in a room`);
  if (!Array.isArray(d.rooms) || d.rooms.length < 4) fail(`seed ${seed}: rooms missing`);
  for (const r of d.rooms ?? []) {
    if (r.w < 4 || r.w > 15 || r.h < 4 || r.h > 15) fail(`seed ${seed}: room ${r.w}x${r.h} at ${r.x},${r.y} not 4-15 a side`);
  }
  if (JSON.stringify(generateDungeon(seed)) !== JSON.stringify(d)) fail(`seed ${seed}: not deterministic`);

  const dist = floorDistances(d, d.start);
  let floor = 0, edges = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d.tiles[y][x] !== '.') continue;
      floor++;
      if (d.tiles[y][x + 1] === '.') edges++;
      if (d.tiles[y + 1]?.[x] === '.') edges++;
    }
  }
  if (dist.size !== floor) fail(`seed ${seed}: floor not fully connected (${dist.size}/${floor})`);
  let maxD = 0;
  for (const v of dist.values()) maxD = Math.max(maxD, v);
  const td = dist.get(d.treasure.join());
  if (td === undefined) fail(`seed ${seed}: treasure unreachable`);
  else if (td < 0.6 * maxD) fail(`seed ${seed}: treasure too close (${td} < 0.6 * ${maxD})`);
  if (edges < floor) fail(`seed ${seed}: floor graph has no cycles`);
  if (seed <= 40) {
    // Loops through corridors, not just room interiors: some corridor cell is not a bridge.
    const corridorCells = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      if (d.tiles[y][x] === '.' && !inRoom(d, [x, y])) corridorCells.push([x, y]);
    }
    let hasLoop = false;
    for (let i = 0; i < corridorCells.length && !hasLoop; i += Math.max(1, Math.floor(corridorCells.length / 60))) {
      const [cx, cy] = corridorCells[i];
      const cut = { ...d, tiles: d.tiles.map((r, y) => (y === cy ? r.slice(0, cx) + '#' + r.slice(cx + 1) : r)) };
      const from = Object.values(DIRS).map(([dx, dy]) => [cx + dx, cy + dy]).find((c) => cut.tiles[c[1]][c[0]] === '.');
      if (from && floorDistances(cut, from).size === floor - 1) hasLoop = true;
    }
    if (!hasLoop) fail(`seed ${seed}: no corridor loop found`);
  }
}
console.log(`generation: ${SEEDS} seeds checked; widths ${minW}-${maxW}, heights ${minH}-${maxH}`);

// 2. Line of sight: symmetric, adjacent cells always see each other, walls block.
{
  const rand = rng(777);
  let pairs = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const d = generateDungeon(seed);
    const floor = [];
    d.tiles.forEach((r, y) => [...r].forEach((c, x) => c === '.' && floor.push([x, y])));
    for (let i = 0; i < 400; i++) {
      const a = floor[Math.floor(rand() * floor.length)];
      const b = [a[0] + Math.floor(rand() * 17) - 8, a[1] + Math.floor(rand() * 17) - 8];
      if (b[0] < 0 || b[1] < 0 || b[0] >= d.width || b[1] >= d.height) continue;
      pairs++;
      if (hasLineOfSight(d, a, b) !== hasLineOfSight(d, b, a)) fail(`seed ${seed}: LOS not symmetric ${a} ${b}`);
    }
    for (const a of floor.slice(0, 200)) {
      for (const [dx, dy] of Object.values(DIRS)) {
        const b = [a[0] + dx, a[1] + dy];
        if (!hasLineOfSight(d, a, b)) fail(`seed ${seed}: adjacent ${a} ${b} not in sight`);
      }
    }
  }
  const box = { width: 7, height: 3, tiles: ['.......', '...#...', '.......'] };
  if (hasLineOfSight(box, [0, 1], [6, 1])) fail('LOS passes through a wall');
  if (!hasLineOfSight(box, [0, 0], [6, 0])) fail('LOS blocked in open row');
  const diag = { width: 3, height: 3, tiles: ['.#.', '#..', '...'] };
  if (hasLineOfSight(diag, [0, 0], [2, 2])) fail('LOS slips through a diagonal wall gap');
  console.log(`line of sight: ${pairs} random pairs symmetric, adjacency and wall cases ok`);
}

// 3. Fog of war during random walks, with adversaries.
// (a) While the chest is unknown, nothing may mention it or its coordinates.
// (b) Twin test: rewrite every unknown tile at random, move the chest to another unknown cell,
//     move every adversary the explorer cannot see to a random place and mode (still unseen),
//     scramble rooms/floorCount, and on some twins grow the map to the right and bottom with
//     random unknown cells (the map edge must not show). Perception output must not change.
const MODES = ['patrol', 'chase', 'search'];

// Encounter facts and tactic options are checked for the two extreme minimum gaps
// (aggressive and scared), so sentiment-dependent output is covered too.
const GAPS = [...new Set([SENTIMENTS.aggressive.min_gap, SENTIMENTS.scared.min_gap])];
function perceive(game) {
  const out = { seen: treasureSeen(game), available: availableApproaches(game), situation: situation(game) };
  for (const id of Object.keys(APPROACHES)) {
    if (isTactic(id)) continue;
    out[id] = { target: approachTarget(game, id), moves: describeMoves(game, id) };
  }
  out.tactics = {};
  const inSight = out.situation.threats.length > 0;
  for (const minGap of inSight ? GAPS : [GAPS[0]]) {
    const t = { feasible: tacticFeasibility(game, minGap), options: tacticOptions(game, minGap) };
    for (const id of TACTICS) t[id] = { target: approachTarget(game, id, { minGap }), moves: describeMoves(game, id, { minGap }) };
    out.tactics[minGap] = t;
  }
  return out;
}

// Cells strictly between a and b that hasLineOfSight looks at (same supercover walk).
function sightCells(a, b) {
  if (a[1] > b[1] || (a[1] === b[1] && a[0] > b[0])) [a, b] = [b, a];
  const cells = [];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const nx = Math.abs(dx), ny = Math.abs(dy), sx = Math.sign(dx), sy = Math.sign(dy);
  let x = a[0], y = a[1];
  for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
    const dec = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (dec === 0) { cells.push([x + sx, y], [x, y + sy]); x += sx; y += sy; ix++; iy++; }
    else if (dec < 0) { x += sx; ix++; } else { y += sy; iy++; }
    cells.push([x, y]);
  }
  return cells;
}

// Hand-built adversaries in the contract's shape: some anywhere, some placed in sight.
function placeAdversaries(game, rand) {
  const d = game.dungeon;
  const floor = (c) => d.tiles[c[1]]?.[c[0]] === '.';
  const list = [];
  const hidden = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < 400 && list.length < hidden; i++) {
    const c = [Math.floor(rand() * d.width), Math.floor(rand() * d.height)];
    if (floor(c) && c.join() !== game.pos.join()) list.push(c);
  }
  const wantVisible = rand() < 0.65 ? 1 + Math.floor(rand() * 2) : 0;
  for (let i = 0, got = 0; i < 300 && got < wantVisible; i++) {
    const c = [game.pos[0] + Math.floor(rand() * 15) - 7, game.pos[1] + Math.floor(rand() * 15) - 7];
    if (floor(c) && c.join() !== game.pos.join() && sees(d, game.pos, c)) { list.push(c); got++; }
  }
  game.adversaries = list.map((pos, i) => ({
    id: `a${i + 1}`, pos, mode: MODES[Math.floor(rand() * 3)], budget: 0, lastSeen: null, goal: null,
  }));
}

function twin(game, rand, pad) {
  const d = game.dungeon;
  const visible = game.adversaries.filter((a) => sees(d, game.pos, a.pos));
  const frozen = new Set();
  for (const a of visible) {
    frozen.add(a.pos.join());
    for (const c of sightCells(game.pos, a.pos)) frozen.add(c.join());
  }
  const W = d.width + (pad ? 1 + Math.floor(rand() * 20) : 0);
  const H = d.height + (pad ? 1 + Math.floor(rand() * 20) : 0);
  const unknown = [];
  const light = [];
  const tiles = [];
  for (let y = 0; y < H; y++) {
    const row = [], lrow = [];
    for (let x = 0; x < W; x++) {
      const inside = x < d.width && y < d.height;
      if (inside && isKnown(game, [x, y])) { row.push(d.tiles[y][x]); lrow.push(game.light[y][x]); continue; }
      if (!inside && isKnown(game, [x, y])) { row.push('#'); lrow.push(0.5); continue; } // lit rock past the edge
      lrow.push(0);
      if (inside && frozen.has(`${x},${y}`)) { row.push(d.tiles[y][x]); continue; }
      unknown.push([x, y]);
      row.push(rand() < 0.5 ? '.' : '#');
    }
    tiles.push(row);
    light.push(lrow);
  }
  let treasure = d.treasure;
  if (!isKnown(game, treasure) && unknown.length > 1) {
    do treasure = unknown[Math.floor(rand() * unknown.length)];
    while (treasure.join() === d.treasure.join());
    tiles[treasure[1]][treasure[0]] = '.';
  }
  const dungeon = { ...d, width: W, height: H, tiles: tiles.map((r) => r.join('')), treasure, rooms: [] };
  // Lit rock past the edge that the grown map now covers is inside it (as known '#' above).
  const litOutside = new Set([...game.litOutside].filter((k) => {
    const [x, y] = k.split(',').map(Number);
    return x < 0 || y < 0 || x >= W || y >= H;
  }));
  const floorCells = [];
  dungeon.tiles.forEach((r, y) => [...r].forEach((c, x) => c === '.' && floorCells.push([x, y])));
  const adversaries = game.adversaries.map((a) => {
    if (visible.includes(a)) return { ...a, pos: [...a.pos] };
    let pos;
    do pos = floorCells[Math.floor(rand() * floorCells.length)];
    while (pos.join() === game.pos.join() || sees(dungeon, game.pos, pos));
    return { ...a, pos: [...pos], mode: MODES[Math.floor(rand() * 3)] };
  });
  const copy = {
    ...game, dungeon, light, litOutside, adversaries,
    floorCount: Math.floor(rand() * 1e5),
  };
  // Sanity of the twin itself: same adversaries visible.
  const v1 = JSON.stringify(visibleAdversaries(game)), v2 = JSON.stringify(visibleAdversaries(copy));
  if (v1 !== v2) fail(`twin changed the visible adversaries: ${v1} vs ${v2}`);
  return copy;
}

// First differing path between two outputs, for readable failures.
function firstDiff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 200)} vs ${JSON.stringify(b)?.slice(0, 200)}`;
}

const mentionsChest = /treasure|chest/i;
let walks = 0, unseenSteps = 0, twinChecks = 0, padded = 0, withVisible = 0, withChaser = 0, visMismatch = 0;
const tacticSeen = new Map(); // tactic id -> times offered in the twin walks
for (const seed of [3, 7, 17, 42, 99, 123, 2024]) {
  const game = createGame(generateDungeon(seed));
  const rand = rng(seed * 7919);
  const [tx, ty] = game.dungeon.treasure;
  const coord = new RegExp(`(^|[^\\d])${tx}\\s*,\\s*${ty}([^\\d]|$)`);
  walks++;
  for (let i = 0; i < 250 && !game.won; i++) {
    placeAdversaries(game, rand);
    const mine = game.adversaries.filter((a) => sees(game.dungeon, game.pos, a.pos)).map((a) => a.id).join();
    const vis = visibleAdversaries(game);
    if (vis.map((a) => a.id).join() !== mine) visMismatch++;
    const seen = perceive(game);
    if (vis.length) withVisible++;
    for (const t of Object.values(seen.tactics)) for (const id of Object.keys(t.options)) tacticSeen.set(id, (tacticSeen.get(id) ?? 0) + 1);
    if (vis.some((a) => a.mode === 'chase')) withChaser++;
    for (const [g, t] of Object.entries(seen.tactics)) {
      const ids = Object.keys(t.options);
      if (vis.length ? !ids.includes('run_away') : ids.length) fail(`seed ${seed} gap ${g}: tactic options ${ids} with ${vis.length} in sight`);
      if (ids.includes('carry_on') && vis.some((a) => a.mode === 'chase')) fail(`seed ${seed}: carry_on offered while chased`);
      if (ids.includes('race_to_chest') && !treasureSeen(game)) fail(`seed ${seed}: race_to_chest offered before the chest is seen`);
      if (ids.some((id) => !isTactic(id))) fail(`seed ${seed}: non-tactic option ${ids}`);
    }
    if (seen.available.some((id) => isTactic(id))) fail(`seed ${seed}: tactic in availableApproaches`);
    if (!!seen.situation.encounter !== vis.length > 0) fail(`seed ${seed}: situation.encounter ${!!seen.situation.encounter} with ${vis.length} in sight`);
    if (seen.situation.threats.length !== vis.length) fail(`seed ${seed}: threats count ${seen.situation.threats.length} vs ${vis.length}`);
    if (!treasureSeen(game)) {
      unseenSteps++;
      if (seen.available.includes('go_to_treasure')) fail(`seed ${seed} step ${game.steps}: go_to_treasure offered early`);
      if (seen.situation.treasure !== 'not seen yet') fail(`seed ${seed}: situation.treasure = ${seen.situation.treasure}`);
      const { treasure, ...rest } = seen.situation;
      // The tactic id race_to_chest is a key, not text sent while unseen (it is never offered then).
      const texts = [JSON.stringify(rest), JSON.stringify(seen.tactics).replace(/race_to_chest/g, 'race_tactic')];
      for (const id of Object.keys(APPROACHES)) if (!isTactic(id)) texts.push(JSON.stringify(seen[id]));
      for (const text of texts) {
        if (mentionsChest.test(text)) fail(`seed ${seed} step ${game.steps}: mentions the chest early: ${text.slice(0, 160)}`);
        if (coord.test(text)) fail(`seed ${seed} step ${game.steps}: contains chest coordinates`);
      }
    }
    for (let k = 0; k < 2; k++) {
      twinChecks++;
      const pad = k === 1;
      if (pad) padded++;
      const other = JSON.stringify(perceive(twin(game, rand, pad)));
      if (other !== JSON.stringify(seen)) {
        fail(`seed ${seed} step ${game.steps}: output depends on hidden state${pad ? " (padded map)" : ""}: ${firstDiff(seen, JSON.parse(other))}`);
      }
    }
    game.adversaries = [];
    const moves = legalMoves(game);
    applyMove(game, moves[Math.floor(rand() * moves.length)]);
  }
}
if (visMismatch) fail(`visibleAdversaries disagrees with SIGHT_RANGE + hasLineOfSight on ${visMismatch} steps`);
if (!withChaser) fail('no twin check had a visible chaser');
console.log(`fog of war: ${walks} random walks, ${unseenSteps} steps with the chest unseen, ${twinChecks} twin comparisons `
  + `(${padded} on grown maps; ${withVisible} steps with a visible adversary, ${withChaser} with a visible chaser)`);
console.log(`  tactic options offered in twin walks (gaps ${GAPS}): ${[...tacticSeen].map(([id, n]) => `${id} ${n}`).join(', ')}`);
for (const id of ['slip_past', 'run_away', 'hide']) if (!tacticSeen.get(id)) fail(`twin walks never offered ${id}`);

// 4. Won/lost games are frozen; publicView shape.
{
  const g = createGame(generateDungeon(5));
  g.lost = true; g.caughtBy = 'a1';
  const before = JSON.stringify(g.pos);
  if (legalMoves(g).length) fail('legalMoves not empty once lost');
  if (applyMove(g, 'up').moved || applyMove(g, 'down').moved || JSON.stringify(g.pos) !== before) fail('applyMove moved after loss');
  const v = publicView(g);
  if (v.lost !== true) fail('publicView.lost missing');
  if (v.light.flat().some((b) => Math.round(b * 100) / 100 !== b)) fail('publicView.light not rounded to 2 decimals');
  if (!Array.isArray(g.adversaries) || g.caughtBy !== 'a1') fail('Game shape');
  console.log('frozen games and publicView: ok');
}

// 4b. Threat sentences on a small, fully lit hand-built map: a one-entrance room above a loop.
{
  const tiles = [
    '###########',
    '#...#######',
    '#...#######',
    '#...#######',
    '##.########',
    '#.........#',
    '#.#######.#',
    '#.........#',
    '###########',
  ];
  const d = { seed: 0, width: 11, height: 9, tiles, start: [2, 5], treasure: [9, 7], rooms: [{ x: 1, y: 1, w: 3, h: 3 }] };
  const g = createGame(d);
  g.light = g.light.map((row) => row.map(() => 1));
  const adv = (pos, mode) => ({ id: 'a1', pos, mode, budget: 0, lastSeen: null, goal: null });

  g.adversaries = [adv([3, 5], 'chase')];
  const caught = describeMoves(g, 'run_away');
  if (!caught.right?.startsWith('Steps into the adversary: caught.')) fail(`caught sentence missing: ${caught.right}`);

  g.adversaries = [adv([6, 5], 'chase')];
  const cornered = describeMoves(g, 'run_away');
  if (!cornered.up?.includes('Leads into a known dead end: risk of being cornered.')) fail(`cornered sentence missing: ${cornered.up}`);
  if (cornered.left?.includes('cornered')) fail(`loop move flagged as cornered: ${cornered.left}`);
  if (!cornered.left?.includes('Moves away from the chasing adversary')) fail(`away sentence missing: ${cornered.left}`);
  const esc = approachTarget(g, 'run_away');
  const exits = esc && Object.values(DIRS).filter(([dx, dy]) => tiles[esc.cell[1] + dy][esc.cell[0] + dx] === '.').length;
  if (!esc || esc.cell.join() === g.pos.join() || exits < 2) fail(`bad run_away target ${JSON.stringify(esc)}`);
  if (situation(g).threats[0]?.direction !== 'east' || situation(g).threats[0]?.distance !== 4) fail(`threat entry ${JSON.stringify(situation(g).threats)}`);

  g.adversaries = [adv([9, 7], 'patrol')]; // out of sight
  if (approachTarget(g, 'run_away') !== null || Object.keys(tacticOptions(g)).length) fail('run_away offered with nothing in sight');
  console.log('threat sentences: caught, cornered, loop, run_away target ok');
  console.log('  caught sample   right:', caught.right);
  console.log('  cornered sample up:   ', cornered.up);
  console.log('  loop sample     left: ', cornered.left);
  console.log('  run_away target:      ', JSON.stringify(esc));
}

// 4c. Encounter tactics on hand-built maps (min gaps from the sentiment profiles).
const handGame = (tiles, pos, litCols = Infinity) => {
  // The chest sits off the map, never lit, so it stays unseen.
  const d = { seed: 0, width: tiles[0].length, height: tiles.length, tiles, start: pos, treasure: [-9, -9], rooms: [] };
  const g = createGame(d);
  g.light = g.light.map((row) => row.map((_, x) => (x <= litCols ? 1 : 0)));
  return g;
};
const chaser = (pos, mode = 'chase', id = 'a1') => ({ id, pos, mode, budget: 0, lastSeen: null, goal: null });
const SCARED = SENTIMENTS.scared.min_gap, AGGRO = SENTIMENTS.aggressive.min_gap;
{
  // (a) Big room, adversary off to the side, unexplored corridor on the far side: a route past exists.
  const room = [
    '######################',
    '#..............#######',
    '#..............#######',
    '#..............#######',
    '#..............#######',
    '#..................###',
    '#..............#######',
    '#..............#######',
    '#..............#######',
    '#..............#######',
    '######################',
  ];
  const g = handGame(room, [2, 2], 16); // the corridor beyond x = 16 is dark
  g.adversaries = [chaser([5, 8])];
  const aggro = tacticFeasibility(g, AGGRO), scared = tacticFeasibility(g, SCARED);
  if (!aggro.slip_past) fail(`room: slip_past not feasible for aggressive: ${JSON.stringify(Object.keys(aggro))}`);
  if (scared.slip_past) fail(`room: slip_past feasible for scared (min gap ${SCARED}): ${scared.slip_past.fact}`);
  if (!aggro.face_off) fail('room: face_off not feasible in a 14x9 room');
  if (!aggro.run_away || !scared.run_away) fail('room: run_away missing');
  if (aggro.carry_on) fail('room: carry_on offered while chased');
  const enc = situation(g).encounter;
  if (!/Open room, about 14×9/.test(enc?.space)) fail(`room: space fact ${enc?.space}`);
  if (!/closest approach/.test(enc?.slip_past)) fail(`room: slip fact ${enc?.slip_past}`);
  const moves = describeMoves(g, 'slip_past', { minGap: AGGRO });
  const movesScared = describeMoves(g, 'run_away', { minGap: 9 });
  if (!Object.values(movesScared).some((m) => m.includes('below your minimum gap of 9'))) fail('min gap warning missing in move facts');
  g.adversaries = [chaser([5, 8], 'patrol')];
  if (!tacticFeasibility(g, AGGRO).carry_on) fail('room: carry_on not offered for a patroller');
  console.log('encounter (room): slip_past feasible for aggressive, not for scared; face_off, run_away, carry_on ok');
  console.log('  encounter facts:', JSON.stringify(enc));
  console.log('  slip_past (aggressive):', aggro.slip_past.fact);
  console.log('  move facts slip_past:', JSON.stringify(moves));

  // (b) Corridor with the adversary between the explorer and the dark end: no way past.
  const corridor = ['############', '#..........#', '############'];
  const c = handGame(corridor, [2, 1], 8);
  c.adversaries = [chaser([6, 1])];
  const cf = tacticFeasibility(c, AGGRO);
  if (cf.slip_past || cf.face_off || cf.hide) fail(`corridor: ${Object.keys(cf)} offered`);
  if (!cf.run_away) fail('corridor: run_away missing');
  if (!/Narrow corridor/.test(situation(c).encounter?.space)) fail(`corridor space ${situation(c).encounter?.space}`);

  // (c) Room whose only exit (toward the dark) is blocked by the adversary standing in it.
  const blocked = [
    '############',
    '#......#####',
    '#......#####',
    '#...........',
    '#......#####',
    '#......#####',
    '############',
  ];
  const b = handGame(blocked, [2, 3], 9);
  b.adversaries = [chaser([7, 3])];
  if (tacticFeasibility(b, AGGRO).slip_past) fail('blocked exit: slip_past offered');
  console.log('encounter (corridor, blocked exit): slip_past not offered; run_away only');

  // (d) Hide: a side passage around a corner, out of the adversary's sight.
  const alcove = [
    '##########',
    '#......###',
    '#.........',
    '#......##.',
    '#......##.',
    '#......##.',
    '#......###',
    '##########',
  ];
  const h = handGame(alcove, [5, 2]);
  h.adversaries = [chaser([1, 6])];
  const hf = tacticFeasibility(h, SCARED);
  if (!hf.hide) fail(`hide not feasible: ${JSON.stringify(Object.keys(hf))}`);
  else if (knownLineOfSight(h, [1, 6], hf.hide.target.cell)) fail(`hide cell ${hf.hide.target.cell} is in sight`);
  // Unknown cells block known-tile LOS: darken the passage and the same pair is "out of sight".
  const h2 = handGame(alcove, [5, 2]);
  if (!knownLineOfSight(h2, [1, 1], [6, 6])) fail('known LOS blocked in an open lit room');
  h2.light[3][3] = 0; h2.light[4][4] = 0;
  if (knownLineOfSight(h2, [1, 1], [6, 6])) fail('unknown cells do not block known LOS');
  console.log('encounter (alcove): hide ->', hf.hide?.fact);
}

// 4d. Brain bookkeeping with a stub Jev: an encounter never puts a tactic into `tried`, the
//     parked approach resumes, and the turn/memory shapes hold. No network, temp memory dir.
{
  const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
  setMemoryDir(pathToFileURL(dir + '/'));
  const asked = [];
  let mood = 'calculated';
  setAsker(async ({ kind, questions }) => {
    asked.push({ kind, questions: Object.keys(questions) });
    const first = (q) => Object.keys(q.criteria)[0];
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') answers[k] = { noul: 0.9 };
      else if (k === 'sentiment') answers[k] = { choice: mood, probabilities: { [mood]: 1 }, confidence: 1 };
      else if (k === 'tactic') {
        const ids = Object.keys(q.criteria);
        const c = ids.find((id) => id !== 'run_away') ?? ids[0];
        answers[k] = { choice: c, probabilities: { [c]: 1 }, confidence: 1 };
      } else answers[k] = { choice: first(q), probabilities: { [first(q)]: 1 }, confidence: 1 };
    }
    return answers;
  });
  const room = [
    '######################',
    '#..............#######',
    '#..............#######',
    '#..............#######',
    '#..............#######',
    '#..................###',
    '#..............#######',
    '#..............#######',
    '#..............#######',
    '#..............#######',
    '######################',
  ];
  const g = handGame(room, [2, 2], 16);
  g.knownFloor = 1; g.visits = { '2,2': 1 };
  const memory = newRun(g);
  const t1 = await takeTurn(g, memory);
  if (t1.decision?.trigger !== 'start' || t1.decision.tactic !== null) fail(`first turn decision ${JSON.stringify(t1.decision)}`);
  if (!asked[0] || asked[0].kind !== 'sentiment') fail('decision tick did not ask sentiment first');
  if (!('move_decision' in t1)) fail('turn.move_decision missing');
  // The stub's first move is random (options are shuffled), so place the adversary relative to where it went.
  const inSightOf = (minD) => {
    const out = [];
    for (let y = 1; y < 10; y++) for (let x = 1; x < 15; x++) {
      if (euclid(g.pos, [x, y]) >= minD && sees(g.dungeon, g.pos, [x, y])) out.push([x, y]);
    }
    return out;
  };
  g.adversaries = [chaser(inSightOf(5)[0])];
  asked.length = 0;
  mood = 'aggressive';
  const t2 = await takeTurn(g, memory);
  if (t2.decision?.trigger !== 'encounter' || !t2.decision.tactic?.choice) fail(`encounter decision ${JSON.stringify(t2.decision)?.slice(0, 300)}`);
  if (asked.map((a) => a.kind).join() !== 'sentiment,tick') fail(`decision tick requests ${JSON.stringify(asked)}`);
  if (!isTactic(memory.approach.id) || memory.approach.interrupted?.id !== 'nearest_frontier') fail(`tactic not parked properly: ${JSON.stringify(memory.approach)}`);
  if (memory.sentiment.id !== 'aggressive' || memory.sentiment_history.at(-1)?.id !== 'aggressive') fail('sentiment not recorded');
  if (!t2.move_decision || !asked[1].questions.includes(`move_if_${t2.decision.tactic.choice}`)) fail('speculative move question missing');
  // An ordinary tick in the encounter (same adversary, in sight): one request, no decision.
  g.adversaries = [chaser(inSightOf(5)[0])];
  asked.length = 0;
  const t3 = await takeTurn(g, memory);
  if (t3.decision !== null || asked.length !== 1) fail(`ordinary encounter tick made a decision: ${JSON.stringify(t3.decision)} ${asked.length}`);
  // Out of sight long enough for the aggressive profile (end_ticks 1): encounter over, approach resumes.
  g.adversaries = [];
  let over = null;
  for (let i = 0; i < 6 && !over; i++) {
    const t = await takeTurn(g, memory);
    if (t.decision?.trigger === 'chase_over') over = t;
  }
  if (!over) fail('encounter never ended');
  else if (over.step !== t3.step + SENTIMENTS.aggressive.end_ticks) fail(`aggressive encounter ended at step ${over.step}, expected ${t3.step + SENTIMENTS.aggressive.end_ticks}`);
  if (memory.approach.id !== 'nearest_frontier' || memory.approach.interrupted) fail(`approach not resumed: ${JSON.stringify(memory.approach)}`);
  if (memory.approach.tried.some((t) => isTactic(t.id))) fail(`tactic in tried: ${JSON.stringify(memory.approach.tried)}`);
  if (memory.approach.thought !== APPROACHES.nearest_frontier.thought) fail(`thought ${memory.approach.thought}`);
  validateMemory(memory);
  console.log(`brain (stub Jev): start -> encounter (${t2.decision.tactic.choice}, aggressive) -> chase_over at step ${over?.step}; tried has no tactics`);
  setAsker(null);
  setMemoryDir(null);
  rmSync(dir, { recursive: true, force: true });
}

// 5. Scripted follower: nearest_frontier until the chest is seen, then go_to_treasure,
//    stepping along the known-floor shortest path to the current target. No adversaries.
function knownStepTowards(game, target) {
  const dist = new Map([[target.join(), 0]]);
  const queue = [target];
  for (let i = 0; i < queue.length; i++) {
    for (const [dx, dy] of Object.values(DIRS)) {
      const n = [queue[i][0] + dx, queue[i][1] + dy];
      if (dist.has(n.join()) || !isKnown(game, n) || game.dungeon.tiles[n[1]][n[0]] !== '.') continue;
      dist.set(n.join(), dist.get(queue[i].join()) + 1);
      queue.push(n);
    }
  }
  const here = dist.get(game.pos.join());
  return legalMoves(game).find((dir) => dist.get([game.pos[0] + DIRS[dir][0], game.pos[1] + DIRS[dir][1]].join()) === here - 1) ?? null;
}

function follow(game, cap = 20000, onTick = null) {
  while (!game.won && game.steps < cap) {
    if (onTick) onTick(game);
    const target = approachTarget(game, treasureSeen(game) ? 'go_to_treasure' : 'nearest_frontier');
    if (!target) return false;
    const dir = knownStepTowards(game, target.cell);
    if (!dir) return false;
    applyMove(game, dir);
  }
  return game.won;
}

function seedsOfSize(lo, hi, count) {
  const out = [];
  for (let s = 1; out.length < count && s < 1e6; s++) {
    const r = rng(s);
    const w = MIN_SIZE + Math.floor(r() * (MAX_SIZE - MIN_SIZE + 1));
    const h = MIN_SIZE + Math.floor(r() * (MAX_SIZE - MIN_SIZE + 1));
    if (w >= lo && w <= hi && h >= lo && h <= hi) out.push(s);
  }
  return out;
}

{
  const quick = seedsOfSize(35, 40, 2);
  for (const s of quick) if (!follow(createGame(generateDungeon(s)))) fail(`follower did not win seed ${s}`);
  console.log(`follower: won ${quick.length} quick games`);
}

if (MEASURE) {
  console.log('\n--- measurement (scripted follower, no adversaries) ---');
  let longest = { steps: 0 };
  for (const [label, lo, hi] of [['~35x35', 35, 40], ['~150x150', 140, 150]]) {
    const rows = [];
    for (const s of seedsOfSize(lo, hi, 10)) {
      const g = createGame(generateDungeon(s));
      const t0 = performance.now();
      const won = follow(g);
      rows.push({ s, size: `${g.dungeon.width}x${g.dungeon.height}`, steps: g.steps, won, explored: publicView(g).explored_pct, ms: Math.round(performance.now() - t0) });
      if (!won) fail(`follower did not win seed ${s}`);
      if (lo >= 140 && g.steps > longest.steps) longest = { s, steps: g.steps };
    }
    const steps = rows.map((r) => r.steps).sort((a, b) => a - b);
    console.log(`${label}: mean ${Math.round(steps.reduce((a, b) => a + b, 0) / steps.length)} steps, median ${steps[steps.length >> 1]}, min ${steps[0]}, max ${steps.at(-1)}`);
    console.log('  ' + rows.map((r) => `seed ${r.s} ${r.size}: ${r.steps} steps, ${r.explored}% explored`).join('\n  '));
  }

  // Per-tick perception cost late in a large game: describeMoves + situation + approachTarget.
  // Uses the longest large game, played to 90% of its winning run, when the known area is largest.
  const bigSeed = longest.s;
  const g = createGame(generateDungeon(bigSeed));
  follow(g, Math.floor(longest.steps * 0.9));
  const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  const tick = (approach) => time(() => { situation(g); approachTarget(g, approach); describeMoves(g, approach); });
  const calm = [], chased = [];
  const floorNear = [];
  for (let i = 0; i < 60 && !g.won; i++) {
    const approach = treasureSeen(g) ? 'go_to_treasure' : 'nearest_frontier';
    g.adversaries = [];
    calm.push(tick(approach));
    // Put a chaser in sight, a few cells away.
    floorNear.length = 0;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const c = [g.pos[0] + dx, g.pos[1] + dy];
      if ((dx || dy) && g.dungeon.tiles[c[1]]?.[c[0]] === '.' && sees(g.dungeon, g.pos, c)) floorNear.push(c);
    }
    if (floorNear.length) {
      g.adversaries = [{ id: 'a1', pos: floorNear.at(-1), mode: 'chase', budget: 0, lastSeen: null, goal: null }];
      chased.push(time(() => { situation(g); approachTarget(g, 'run_away'); describeMoves(g, 'run_away'); tacticOptions(g, 3); }));
    }
    g.adversaries = [];
    const target = approachTarget(g, approach);
    const dir = target && knownStepTowards(g, target.cell);
    if (!dir) break;
    applyMove(g, dir);
  }
  const stat = (xs) => { const s = [...xs].sort((a, b) => a - b); return `median ${s[s.length >> 1].toFixed(2)} ms, max ${s.at(-1).toFixed(2)} ms (${s.length} ticks)`; };
  console.log(`\nper-tick perception on seed ${bigSeed} (${g.dungeon.width}x${g.dungeon.height}), step ${g.steps}, ${g.knownFloor} known floor cells:`);
  console.log(`  no adversary in sight: ${stat(calm)}`);
  if (chased.length) console.log(`  chaser in sight (run_away + tactic options): ${stat(chased)}`);
  const fd = []; for (let i = 0; i < 50; i++) fd.push(time(() => floorDistances(g.dungeon, g.pos)));
  console.log(`  floorDistances (adversary pathing, full map): ${stat(fd)}`);
}

// 6. Samples to eyeball: a minimum-size map with its real adversaries, and threat output.
{
  const [small] = seedsOfSize(35, 35, 1);
  const d = generateDungeon(small);
  const g = createGame(d);
  g.adversaries = spawnAdversaries(d);
  const render = (game, reveal) => game.dungeon.tiles.map((row, y) => [...row].map((c, x) => {
    if (x === game.pos[0] && y === game.pos[1]) return '@';
    const a = game.adversaries.find((v) => v.pos[0] === x && v.pos[1] === y);
    if (a) return a.mode === 'chase' ? 'C' : 'A';
    if (x === game.dungeon.treasure[0] && y === game.dungeon.treasure[1]) return 'T';
    if (reveal || isKnown(game, [x, y])) return c;
    return c === '#' ? ' ' : ',';
  }).join('')).join('\n');
  console.log(`\nseed ${small} (${d.width}x${d.height}), full map (@ explorer, T chest, A adversary):`);
  console.log(render(g, true));

  // Walk toward the chest's side, then put a chaser in sight and show what Jev would get.
  for (let i = 0; i < 12; i++) {
    const t = approachTarget(g, 'far_side');
    const dir = t && knownStepTowards(g, t.cell);
    if (dir) applyMove(g, dir);
  }
  const near = [];
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    const c = [g.pos[0] + dx, g.pos[1] + dy];
    if ((dx || dy) && d.tiles[c[1]]?.[c[0]] === '.' && sees(d, g.pos, c) && euclid(g.pos, c) >= 3) near.push(c);
  }
  g.adversaries = [{ id: 'a1', pos: near[0] ?? g.pos, mode: 'chase', budget: 0, lastSeen: null, goal: null },
    { id: 'a2', pos: near.at(-1) ?? g.pos, mode: 'patrol', budget: 0, lastSeen: null, goal: null }];
  console.log(`\nafter ${g.steps} steps with a chaser (C) and a patroller (A) in sight; blank/"," = unknown wall/floor:`);
  console.log(render(g, false));
  console.log('\nsituation:', JSON.stringify(situation(g), null, 2));
  console.log('availableApproaches:', availableApproaches(g).join(', '));
  console.log('approachTarget(run_away):', JSON.stringify(approachTarget(g, 'run_away')));
  console.log('describeMoves(run_away):', JSON.stringify(describeMoves(g, 'run_away'), null, 2));
  for (const id of ['scared', 'calculated', 'aggressive']) {
    console.log(`tacticOptions (${id}, min gap ${SENTIMENTS[id].min_gap}):`, JSON.stringify(tacticOptions(g, SENTIMENTS[id].min_gap), null, 2));
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
