// Sanity checks for the dungeon generator, line of sight and the fog of war.
// Run from the dungeon-game directory: node scripts/check-dungeon.mjs [--measure]
//   --measure  also plays ~10 small and ~10 large maps with a scripted follower (no Jev)
//              and times perception per tick on a 150x150 map.

import {
  generateDungeon, Game, STAY, rng, hasLineOfSight, floorDistances,
  DIRS, EXPLORER_LIVES, SIGHT_RANGE, MIN_SIZE, MAX_SIZE,
} from '../src/dungeon.js';
import {
  APPROACHES, TACTICS, isTactic, situation, describeMoves, approachTarget, availableApproaches, exitSeen,
  tacticFeasibility, tacticOptions, avoidZone, describeMoveParts,
} from '../src/characters/explorer/perception.js';
import { knownLineOfSight } from '../src/characters/explorer/encounter.js';
import { SENTIMENTS, ExplorerBrain } from '../src/characters/explorer/brain.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { LIMITS, MOOD_IDS, addEvent, addLandmark, createMemory, validateMemory } from '../src/characters/explorer/memory.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Adversary, visibleAdversaries, spawnAdversaries } from '../src/characters/adversary/adversary.js';
import { configureSkills, skillConfig } from '../src/skills/loadouts.js';

// Tripwire: the brain checks inject stubs; a missed one would call the paid Jev API.
globalThis.fetch = () => { throw new Error('network call in a check script'); };

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

// 0. Static fog guard: explorer code reads the game only through KnownWorld (known-world.js is the
//    one file allowed to hold a Game). Catches `game.x`, `game[...]`, `.dungeon` and imports of
//    anything beyond the allowlist, so a hidden-state read cannot slip in unnoticed.
const ALLOWED_IMPORTS = {
  './perception.js': null, './memory.js': null, './encounter.js': null, './known-map.js': null,
  '../../jev.js': null, 'node:fs/promises': null,
  // SIGHT_RANGE is a constant, not hidden state: brain.js uses it to expire a remembered sighting once
  // the explorer stands within sight range of the frozen cell with a known line of sight to it.
  '../../dungeon.js': ['DIRS', 'LIGHT_RADIUS', 'STAY', 'EXPLORER_LIVES', 'SIGHT_RANGE'],
  '../adversary/adversary.js': ['ADVERSARY_SPEED', 'GRACE_TICKS'],
  // Pure helpers shared with the adversary side (PLAN-adversary-memory.md A3); they import nothing from the game.
  '../shared/memory-kit.js': null,
  // Skills (PLAN-skills.md): the brain builds its skill set and asks the `skill` question through these two
  // modules only. They hold no game state; src/skills/ is guarded below (section 0c). resolve.js is not allowed.
  // skillConfig returns the settings numbers (stun ticks, coin drop chance) for the rules sentence: no game state.
  '../../skills/loadouts.js': ['buildSkillSet', 'skillConfig'],
  '../../skills/question.js': ['skillQuestion', 'pickSkill'],
};
function fogViolations(name, source, allowedImports = ALLOWED_IMPORTS) {
  const out = [];
  const code = source.replace(/(^|[^:'"\\])\/\/.*$/gm, '$1'); // line comments may talk about the game
  if (/\bgame\s*\??\.[A-Za-z_$#]/.test(code)) out.push(`${name}: reads a game property`);
  if (/\bgame\s*\[/.test(code)) out.push(`${name}: indexes a game`);
  if (/\.dungeon\b/.test(code)) out.push(`${name}: reads .dungeon`);
  if (/\bimport\s*\(/.test(code)) out.push(`${name}: dynamic import`);
  if (/\bimport\s*\*/.test(code)) out.push(`${name}: namespace import`);
  // Re-exports count too: `export { x } from` would hand a hidden-state helper to explorer code.
  for (const m of code.matchAll(/\b(?:import|export)\s+([^'"]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const [, names, spec] = m;
    if (!(spec in allowedImports)) { out.push(`${name}: imports ${spec}`); continue; }
    const allowed = allowedImports[spec];
    if (allowed) {
      const wanted = names.replace(/[{}]/g, '').split(',').map((n) => n.trim()).filter(Boolean);
      for (const n of wanted) if (!allowed.includes(n)) out.push(`${name}: imports ${n} from ${spec}`);
    }
  }
  return out;
}
{
  const self = fogViolations('synthetic', "const t = game.dungeon.tiles;\nimport { isFloor } from '../../dungeon.js';");
  if (self.length < 2) fail(`fog guard self-test found ${self.length} violations in a bad snippet`);
  const reexport = fogViolations('synthetic', 'export { isFloor } from "../../dungeon.js";');
  if (reexport.length < 1) fail('fog guard self-test missed a re-export of a hidden-state helper');
  const dirUrl = new URL('../src/characters/explorer/', import.meta.url);
  const files = readdirSync(dirUrl).filter((f) => f.endsWith('.js') && f !== 'known-world.js');
  if (!files.includes('brain.js') || !files.includes('perception.js')) fail('fog guard: explorer files not found');
  for (const f of files) for (const v of fogViolations(f, readFileSync(new URL(f, dirUrl), 'utf8'))) fail(`static fog guard: ${v}`);
}

// 0b. The same guard for ghosts (PLAN-adversary-memory.md section 4): adversary perception, brain, memory
//     (and character.js once it exists) read the world only through an AdversaryView. adversary.js (physics)
//     and adversary-view.js are exempt, like known-world.js.
const ADVERSARY_ALLOWED_IMPORTS = {
  './perception.js': null, './brain.js': null, './memory.js': null, './character.js': null, './adversary-view.js': null,
  '../shared/memory-kit.js': null, '../../jev.js': null, 'node:fs/promises': null,
  // rng is the pure seeded PRNG (character.js assignCharacters uses its own stream), not a world read.
  '../../dungeon.js': ['DIRS', 'SIGHT_RANGE', 'rng'],
  './adversary.js': ['ADVERSARY_SPEED'],
  // The ghost's skill set and `skill` question (PLAN-skills.md S4), same pure modules as the explorer's.
  '../../skills/loadouts.js': ['buildSkillSet'],
  '../../skills/question.js': ['skillQuestion', 'pickSkill'],
};
{
  const adv = (n, src) => fogViolations(n, src, ADVERSARY_ALLOWED_IMPORTS);
  if (adv('synthetic', "const t = game.dungeon.tiles;\nimport { isFloor, floorDistances } from '../../dungeon.js';").length < 3) fail('adversary fog guard missed a game read or hidden-state imports');
  if (adv('synthetic', "import { hasLineOfSight } from '../../dungeon.js';").length < 1) fail('adversary fog guard missed hasLineOfSight');
  if (adv('synthetic', "import { Game } from '../../dungeon.js';").length < 1) fail('adversary fog guard missed a Game import');
  if (adv('synthetic', "import { DIRS, SIGHT_RANGE } from '../../dungeon.js';\nimport { x } from './perception.js';").length) fail('adversary fog guard rejects allowed imports');
  const advUrl = new URL('../src/characters/adversary/', import.meta.url);
  const guarded = ['perception.js', 'brain.js', 'memory.js', 'character.js'].filter((f) => readdirSync(advUrl).includes(f));
  if (guarded.length < 3) fail('adversary fog guard: adversary files not found');
  for (const f of guarded) for (const v of adv(f, readFileSync(new URL(f, advUrl), 'utf8'))) fail(`adversary static fog guard: ${v}`);
}

// 0c. src/skills/*.js except resolve.js (the one file that mutates a Game, called only from world code):
//     options() reads only the `view` and `self` it is given. No game reads, no .dungeon, imports only from
//     sibling skills files and DIRS from dungeon.js.
{
  const SKILL_ALLOWED_IMPORTS = {
    './skill.js': null, './attack.js': null, './block.js': null, './skill-set.js': null, './loadouts.js': null,
    './question.js': null, './config.js': null, '../dungeon.js': ['DIRS'],
  };
  const sk = (n, src) => fogViolations(n, src, SKILL_ALLOWED_IMPORTS);
  if (sk('synthetic', "const t = game.dungeon.tiles;").length < 2) fail('skills guard missed a game read');
  if (sk('synthetic', "import { isFloor } from '../dungeon.js';").length < 1) fail('skills guard missed isFloor');
  if (sk('synthetic', "import { resolveAttack } from './resolve.js';").length < 1) fail('skills guard missed resolve.js');
  if (sk('synthetic', "import { DIRS } from '../dungeon.js';\nimport { Skill } from './skill.js';").length) fail('skills guard rejects allowed imports');
  const skUrl = new URL('../src/skills/', import.meta.url);
  const files = readdirSync(skUrl).filter((f) => f.endsWith('.js') && f !== 'resolve.js');
  if (files.length < 6 || !files.includes('attack.js')) fail('skills guard: src/skills files not found');
  for (const f of files) for (const v of sk(f, readFileSync(new URL(f, skUrl), 'utf8'))) fail(`skills static guard: ${v}`);
}

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
// (bold and wary), so sentiment-dependent output is covered too.
const GAPS = [...new Set([SENTIMENTS.bold.min_gap, SENTIMENTS.wary.min_gap])];
function perceive(world) {
  const out = { seen: exitSeen(world), available: availableApproaches(world), situation: situation(world) };
  for (const id of Object.keys(APPROACHES)) {
    if (isTactic(id)) continue;
    out[id] = { target: approachTarget(world, id), moves: describeMoves(world, id) };
  }
  out.tactics = {};
  const inSight = out.situation.threats.visible.length > 0;
  for (const minGap of inSight ? GAPS : [GAPS[0]]) {
    const t = { feasible: tacticFeasibility(world, minGap), options: tacticOptions(world, minGap) };
    for (const id of TACTICS) t[id] = { target: approachTarget(world, id, { minGap }), moves: describeMoves(world, id, { minGap }) };
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
  game.adversaries = list.map((pos, i) => new Adversary({
    id: `a${i + 1}`, pos, mode: MODES[Math.floor(rand() * 3)],
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
      if (inside && game.isKnown([x, y])) { row.push(d.tiles[y][x]); lrow.push(game.light[y][x]); continue; }
      if (!inside && game.isKnown([x, y])) { row.push('#'); lrow.push(0.5); continue; } // lit rock past the edge
      lrow.push(0);
      if (inside && frozen.has(`${x},${y}`)) { row.push(d.tiles[y][x]); continue; }
      unknown.push([x, y]);
      row.push(rand() < 0.5 ? '.' : '#');
    }
    tiles.push(row);
    light.push(lrow);
  }
  let treasure = d.treasure;
  if (!game.isKnown(treasure) && unknown.length > 1) {
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
    if (visible.includes(a)) return new Adversary({ ...a, pos: [...a.pos] });
    let pos;
    do pos = floorCells[Math.floor(rand() * floorCells.length)];
    while (pos.join() === game.pos.join() || sees(dungeon, game.pos, pos));
    return new Adversary({ ...a, pos: [...pos], mode: MODES[Math.floor(rand() * 3)] });
  });
  const copy = game.twin({
    dungeon, light, litOutside, adversaries,
    floorCount: Math.floor(rand() * 1e5),
  });
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

const mentionsChest = /treasure|chest|portal/i;
let walks = 0, unseenSteps = 0, twinChecks = 0, padded = 0, withVisible = 0, withChaser = 0, visMismatch = 0;
const tacticSeen = new Map(); // tactic id -> times offered in the twin walks
for (const seed of [3, 7, 17, 42, 99, 123, 2024]) {
  const game = new Game(generateDungeon(seed));
  const rand = rng(seed * 7919);
  const [tx, ty] = game.dungeon.treasure;
  const coord = new RegExp(`(^|[^\\d])${tx}\\s*,\\s*${ty}([^\\d]|$)`);
  walks++;
  for (let i = 0; i < 250 && !game.won; i++) {
    placeAdversaries(game, rand);
    const mine = game.adversaries.filter((a) => sees(game.dungeon, game.pos, a.pos)).map((a) => a.id).join();
    const vis = visibleAdversaries(game);
    if (vis.map((a) => a.id).join() !== mine) visMismatch++;
    const seen = perceive(new KnownWorld(game));
    if (vis.length) withVisible++;
    for (const t of Object.values(seen.tactics)) for (const id of Object.keys(t.options)) tacticSeen.set(id, (tacticSeen.get(id) ?? 0) + 1);
    if (vis.some((a) => a.mode === 'chase')) withChaser++;
    for (const [g, t] of Object.entries(seen.tactics)) {
      const ids = Object.keys(t.options);
      if (vis.length ? !ids.includes('run_away') : ids.length) fail(`seed ${seed} gap ${g}: tactic options ${ids} with ${vis.length} in sight`);
      if (ids.includes('carry_on') && vis.some((a) => a.mode === 'chase')) fail(`seed ${seed}: carry_on offered while chased`);
      if (ids.includes('race_to_exit') && !exitSeen(new KnownWorld(game))) fail(`seed ${seed}: race_to_exit offered before the portal is seen`);
      if (ids.some((id) => !isTactic(id))) fail(`seed ${seed}: non-tactic option ${ids}`);
    }
    if (seen.available.some((id) => isTactic(id))) fail(`seed ${seed}: tactic in availableApproaches`);
    if (!!seen.situation.threats.encounter !== vis.length > 0) fail(`seed ${seed}: threats.encounter ${!!seen.situation.threats.encounter} with ${vis.length} in sight`);
    if (seen.situation.threats.visible.length !== vis.length) fail(`seed ${seed}: threats count ${seen.situation.threats.visible.length} vs ${vis.length}`);
    if (seen.situation.threats.remembered.length) fail(`seed ${seed}: situation alone reports remembered threats`);
    if (!exitSeen(new KnownWorld(game))) {
      unseenSteps++;
      if (seen.available.includes('go_to_exit')) fail(`seed ${seed} step ${game.steps}: go_to_exit offered early`);
      if (seen.situation.surroundings.exit !== 'not seen yet') fail(`seed ${seed}: surroundings.exit = ${seen.situation.surroundings.exit}`);
      const { exit: _exit, ...surroundings } = seen.situation.surroundings;
      const rest = { ...seen.situation, surroundings };
      // The tactic id race_to_exit is a key, not text sent while unseen (it is never offered then).
      const texts = [JSON.stringify(rest), JSON.stringify(seen.tactics).replace(/race_to_exit/g, 'race_tactic')];
      for (const id of Object.keys(APPROACHES)) if (!isTactic(id)) texts.push(JSON.stringify(seen[id]));
      for (const text of texts) {
        if (mentionsChest.test(text)) fail(`seed ${seed} step ${game.steps}: mentions the portal early: ${text.slice(0, 160)}`);
        if (coord.test(text)) fail(`seed ${seed} step ${game.steps}: contains chest coordinates`);
      }
    }
    for (let k = 0; k < 2; k++) {
      twinChecks++;
      const pad = k === 1;
      if (pad) padded++;
      const other = JSON.stringify(perceive(new KnownWorld(twin(game, rand, pad))));
      if (other !== JSON.stringify(seen)) {
        fail(`seed ${seed} step ${game.steps}: output depends on hidden state${pad ? " (padded map)" : ""}: ${firstDiff(seen, JSON.parse(other))}`);
      }
    }
    game.adversaries = [];
    const moves = game.legalMoves();
    game.applyMove(moves[Math.floor(rand() * moves.length)]);
  }
}
if (visMismatch) fail(`visibleAdversaries disagrees with SIGHT_RANGE + hasLineOfSight on ${visMismatch} steps`);
if (!withChaser) fail('no twin check had a visible chaser');
console.log(`fog of war: ${walks} random walks, ${unseenSteps} steps with the chest unseen, ${twinChecks} twin comparisons `
  + `(${padded} on grown maps; ${withVisible} steps with a visible adversary, ${withChaser} with a visible chaser)`);
console.log(`  tactic options offered in twin walks (gaps ${GAPS}): ${[...tacticSeen].map(([id, n]) => `${id} ${n}`).join(', ')}`);
for (const id of ['slip_past', 'run_away', 'hide']) if (!tacticSeen.get(id)) fail(`twin walks never offered ${id}`);

// 3b. STAY is a first-class option: offered, described, and leaves the position unchanged.
{
  const g = new Game(generateDungeon(7));
  const pos = [...g.pos], steps = g.steps, trail = g.trail.length;
  if (!g.availableMoves().includes(STAY) || g.legalMoves().includes(STAY)) fail('availableMoves must add stay to legalMoves');
  if (!(STAY in describeMoves(new KnownWorld(g), Object.keys(APPROACHES)[0]))) fail('describeMoves lacks stay');
  const r = g.applyMove(STAY);
  if (!r.stayed || r.moved || r.revealed !== 0 || g.pos.join() !== pos.join() || g.steps !== steps + 1 || g.trail.length !== trail) fail('stay changed position or did not tick');
}

// 4. Won/lost games are frozen; publicView shape.
{
  const g = new Game(generateDungeon(5));
  g.lost = true; g.caughtBy = 'a1';
  const before = JSON.stringify(g.pos);
  if (g.legalMoves().length) fail('legalMoves not empty once lost');
  if (g.applyMove('stay').stayed || g.steps !== 0) fail('stay acted after loss');
  if (g.applyMove('up').moved || g.applyMove('down').moved || JSON.stringify(g.pos) !== before) fail('applyMove moved after loss');
  const v = g.publicView();
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
  const d = { seed: 0, width: 11, height: 9, tiles, start: [2, 5], treasure: [-9, -9], rooms: [{ x: 1, y: 1, w: 3, h: 3 }] }; // the portal is a wall to every route but its own: keep it off the loop
  const g = new Game(d);
  g.light = g.light.map((row) => row.map(() => 1));
  const adv = (pos, mode) => new Adversary({ id: 'a1', pos, mode });

  g.adversaries = [adv([3, 5], 'chase')];
  const caught = describeMoves(new KnownWorld(g), 'run_away');
  if (!caught.right?.startsWith('Steps into the adversary: only bumps it back, no life lost.')) fail(`bump sentence missing (D3: a touch never costs a life): ${caught.right}`);
  g.health = 1;
  if (!describeMoves(new KnownWorld(g), 'run_away').right?.startsWith('Steps into the adversary: only bumps it back, no life lost.')) fail('last-life bump sentence missing');
  g.graceTicks = 2;
  if (!describeMoves(new KnownWorld(g), 'run_away').right?.startsWith('Steps into the adversary: only bumps it back, no life lost.')) fail('grace bump sentence missing');
  const sit = situation(new KnownWorld(g));
  if (sit.self.lives !== 1 || sit.self.max_lives !== EXPLORER_LIVES || sit.self.hit_protection_steps !== 2) fail(`situation self: ${JSON.stringify(sit.self)}`);
  g.health = g.maxHealth; g.graceTicks = 0;

  g.adversaries = [adv([6, 5], 'chase')];
  const cornered = describeMoves(new KnownWorld(g), 'run_away');
  if (!cornered.up?.includes('Leads into a known dead end: risk of being cornered.')) fail(`cornered sentence missing: ${cornered.up}`);
  if (cornered.left?.includes('cornered')) fail(`loop move flagged as cornered: ${cornered.left}`);
  if (!cornered.left?.includes('Moves away from the chasing adversary')) fail(`away sentence missing: ${cornered.left}`);
  const esc = approachTarget(new KnownWorld(g), 'run_away');
  const exits = esc && Object.values(DIRS).filter(([dx, dy]) => tiles[esc.cell[1] + dy][esc.cell[0] + dx] === '.').length;
  if (!esc || esc.cell.join() === g.pos.join() || exits < 2) fail(`bad run_away target ${JSON.stringify(esc)}`);
  if (situation(new KnownWorld(g)).threats.visible[0]?.direction !== 'east' || situation(new KnownWorld(g)).threats.visible[0]?.distance !== 4) fail(`threat entry ${JSON.stringify(situation(new KnownWorld(g)).threats.visible)}`);

  g.adversaries = [adv([9, 7], 'patrol')]; // out of sight
  if (approachTarget(new KnownWorld(g), 'run_away') !== null || Object.keys(tacticOptions(new KnownWorld(g))).length) fail('run_away offered with nothing in sight');
  console.log('threat sentences: touch is a bump (full/last life/grace), cornered, loop, run_away target ok');
  console.log('  touch sample    right:', caught.right);
  console.log('  cornered sample up:   ', cornered.up);
  console.log('  loop sample     left: ', cornered.left);
  console.log('  run_away target:      ', JSON.stringify(esc));
}

// 4c. Encounter tactics on hand-built maps (min gaps from the sentiment profiles).
const handGame = (tiles, pos, litCols = Infinity) => {
  // The chest sits off the map, never lit, so it stays unseen.
  const d = { seed: 0, width: tiles[0].length, height: tiles.length, tiles, start: pos, treasure: [-9, -9], rooms: [] };
  const g = new Game(d);
  g.light = g.light.map((row) => row.map((_, x) => (x <= litCols ? 1 : 0)));
  return g;
};
const chaser = (pos, mode = 'chase', id = 'a1') => new Adversary({ id, pos, mode });
const WARY = SENTIMENTS.wary.min_gap, AGGRO = SENTIMENTS.bold.min_gap;
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
  const aggro = tacticFeasibility(new KnownWorld(g), AGGRO), wary = tacticFeasibility(new KnownWorld(g), WARY);
  if (!aggro.slip_past) fail(`room: slip_past not feasible for bold: ${JSON.stringify(Object.keys(aggro))}`);
  if (wary.slip_past) fail(`room: slip_past feasible for wary (min gap ${WARY}): ${wary.slip_past.fact}`);
  // engage (close in and fight) needs a ready sword: offered only when armed, for any minimum gap.
  if (aggro.engage) fail('room: engage offered while unarmed');
  const armedAggro = tacticFeasibility(new KnownWorld(g), AGGRO, { armed: true }), armedScared = tacticFeasibility(new KnownWorld(g), WARY, { armed: true });
  if (!armedAggro.engage || !armedScared.engage) fail('room: engage not offered while armed');
  else {
    // A hunting ghost is met 2 steps off (it steps in, the explorer strikes first); one the explorer just
    // stunned is closed in on.
    const t = armedAggro.engage.target;
    if (Math.abs(t.cell[0] - 5) + Math.abs(t.cell[1] - 8) !== 2) fail(`room: engage target ${t.cell} is not 2 steps from the chasing adversary at 5,8`);
    if (!/puts you 2 steps from a1 \(2 of 2 hp\): wait there/.test(armedAggro.engage.fact)) fail(`room: engage fact ${armedAggro.engage.fact}`);
    const st = tacticFeasibility(new KnownWorld(g), AGGRO, { armed: true, stunned: new Set(['a1']) }).engage;
    if (!st || Math.abs(st.target.cell[0] - 5) + Math.abs(st.target.cell[1] - 8) !== 1 || !/still stunned by your strike/.test(st.fact)) fail(`room: engage on a stunned ghost ${JSON.stringify(st)}`);
  }
  if (!aggro.run_away || !wary.run_away) fail('room: run_away missing');
  if (aggro.carry_on) fail('room: carry_on offered while chased');
  const enc = situation(new KnownWorld(g)).threats.encounter;
  if (!/Open room, about 14×9/.test(enc?.space)) fail(`room: space fact ${enc?.space}`);
  if (!/closest approach/.test(enc?.slip_past)) fail(`room: slip fact ${enc?.slip_past}`);
  const moves = describeMoves(new KnownWorld(g), 'slip_past', { minGap: AGGRO });
  const movesScared = describeMoves(new KnownWorld(g), 'run_away', { minGap: 9 });
  if (!Object.values(movesScared).some((m) => m.includes('below your minimum gap of 9'))) fail('min gap warning missing in move facts');
  g.adversaries = [chaser([5, 8], 'patrol')];
  if (!tacticFeasibility(new KnownWorld(g), AGGRO).carry_on) fail('room: carry_on not offered for a patroller');
  console.log('encounter (room): slip_past feasible for bold, not for wary; engage only when armed; run_away, carry_on ok');
  console.log('  engage (armed):', armedAggro.engage?.fact);
  console.log('  encounter facts:', JSON.stringify(enc));
  console.log('  slip_past (bold):', aggro.slip_past.fact);
  console.log('  move facts slip_past:', JSON.stringify(moves));

  // (b) Corridor with the adversary between the explorer and the dark end: no way past.
  const corridor = ['############', '#..........#', '############'];
  const c = handGame(corridor, [2, 1], 8);
  c.adversaries = [chaser([6, 1])];
  const cf = tacticFeasibility(new KnownWorld(c), AGGRO);
  if (cf.slip_past || cf.engage || cf.hide) fail(`corridor: ${Object.keys(cf)} offered`);
  if (!cf.run_away) fail('corridor: run_away missing');
  if (!/Narrow corridor/.test(situation(new KnownWorld(c)).threats.encounter?.space)) fail(`corridor space ${situation(new KnownWorld(c)).threats.encounter?.space}`);

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
  if (tacticFeasibility(new KnownWorld(b), AGGRO).slip_past) fail('blocked exit: slip_past offered');
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
  const hf = tacticFeasibility(new KnownWorld(h), WARY);
  if (!hf.hide) fail(`hide not feasible: ${JSON.stringify(Object.keys(hf))}`);
  else if (knownLineOfSight(new KnownWorld(h), [1, 6], hf.hide.target.cell)) fail(`hide cell ${hf.hide.target.cell} is in sight`);
  // Unknown cells block known-tile LOS: darken the passage and the same pair is "out of sight".
  const h2 = handGame(alcove, [5, 2]);
  if (!knownLineOfSight(new KnownWorld(h2), [1, 1], [6, 6])) fail('known LOS blocked in an open lit room');
  h2.light[3][3] = 0; h2.light[4][4] = 0;
  if (knownLineOfSight(new KnownWorld(h2), [1, 1], [6, 6])) fail('unknown cells do not block known LOS');
  console.log('encounter (alcove): hide ->', hf.hide?.fact);
}

// 4d. Brain bookkeeping with a stub Jev: an encounter never puts a tactic into `tried`, the
//     parked approach resumes, and the turn/memory shapes hold. No network, temp memory dir.
{
  const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
  const asked = [];
  let mood = 'greedy';
  const ask = async ({ kind, questions }) => {
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
  };
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
  const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
  const memory = brain.memory;
  const t1 = await brain.takeTurn();
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
  mood = 'bold';
  const t2 = await brain.takeTurn();
  if (t2.decision?.trigger !== 'encounter' || !t2.decision.tactic?.choice) fail(`encounter decision ${JSON.stringify(t2.decision)?.slice(0, 300)}`);
  if (asked.map((a) => a.kind).join() !== 'sentiment,tick') fail(`decision tick requests ${JSON.stringify(asked)}`);
  if (!isTactic(memory.approach.id) || memory.approach.interrupted?.id !== 'nearest_frontier') fail(`tactic not parked properly: ${JSON.stringify(memory.approach)}`);
  if (memory.sentiment.id !== 'bold' || memory.sentiment_history.at(-1)?.id !== 'bold') fail('sentiment not recorded');
  if (!t2.move_decision || !asked[1].questions.includes(`move_if_${t2.decision.tactic.choice}`)) fail('speculative move question missing');
  // An ordinary tick in the encounter (same adversary, in sight): one request, no decision.
  g.adversaries = [chaser(inSightOf(5)[0])];
  asked.length = 0;
  const t3 = await brain.takeTurn();
  if (t3.decision !== null || asked.length !== 1) fail(`ordinary encounter tick made a decision: ${JSON.stringify(t3.decision)} ${asked.length}`);
  // Out of sight long enough for the bold profile (end_ticks 1): encounter over, approach resumes.
  g.adversaries = [];
  let over = null;
  for (let i = 0; i < 6 && !over; i++) {
    const t = await brain.takeTurn();
    if (t.decision?.trigger === 'chase_over') over = t;
  }
  if (!over) fail('encounter never ended');
  else if (over.step !== t3.step + SENTIMENTS.bold.end_ticks) fail(`bold encounter ended at step ${over.step}, expected ${t3.step + SENTIMENTS.bold.end_ticks}`);
  if (memory.approach.id !== 'nearest_frontier' || memory.approach.interrupted) fail(`approach not resumed: ${JSON.stringify(memory.approach)}`);
  if (memory.approach.tried.some((t) => isTactic(t.id))) fail(`tactic in tried: ${JSON.stringify(memory.approach.tried)}`);
  if (memory.approach.thought !== APPROACHES.nearest_frontier.thought) fail(`thought ${memory.approach.thought}`);
  validateMemory(memory);
  console.log(`brain (stub Jev): start -> encounter (${t2.decision.tactic.choice}, bold) -> chase_over at step ${over?.step}; tried has no tactics`);
  rmSync(dir, { recursive: true, force: true });
}

// 4e. Memory of what was seen (stub Jev, no network, temp memory dir): remembered threats and their
//     twin, move facts and the avoid zone, back-and-forth and tactic_failed, landmarks, events and
//     encounter counters, one sentiment call when an adversary is already in sight, request size.
{
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
  const makeRoom = () => {
    const g = handGame(room, [2, 2], 16);
    g.knownFloor = 1; g.visits = { '2,2': 1 };
    return g;
  };
  const dirOf = (q) => Object.keys(q.criteria);
  const answerWith = (pick) => async ({ kind, questions, body }) => {
    sizes.push({ kind, bytes: Buffer.byteLength(body, 'utf8'), tactics: Object.keys(questions.tactic?.criteria ?? {}).length });
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') answers[k] = { noul: 0.9 };
      else {
        const c = pick(k, dirOf(q));
        answers[k] = { choice: c, probabilities: { [c]: 1 }, confidence: 1 };
      }
    }
    return answers;
  };
  const sizes = [];
  const withSeed = async (n, fn) => {
    const real = Math.random;
    Math.random = rng(n);
    try { return await fn(); } finally { Math.random = real; }
  };

  // (a) Remembered threats: frozen at the sighting, gone from the request's dependence on hidden state.
  {
    const run = async (hiddenCell) => {
      const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
      const g = makeRoom();
      const brain = new ExplorerBrain(new KnownWorld(g), { ask: answerWith((k, ds) => ds[0]), memoryDir: pathToFileURL(dir + '/') });
      g.adversaries = [chaser([8, 2])];
      const asked0 = sizes.length;
      const t1 = await withSeed(1, () => brain.takeTurn());
      const kinds1 = sizes.slice(asked0).map((s) => s.kind).join();
      g.pos = [14, 9]; // far from the sighting, so the frozen cell is not "seen empty"
      g.adversaries = [chaser(hiddenCell)];
      if (visibleAdversaries(g).length) fail('remembered twin: the hidden adversary is visible');
      await withSeed(2, () => brain.takeTurn());
      const second = JSON.stringify(brain.lastRequests());
      const state = brain.lastRequest().state;
      rmSync(dir, { recursive: true, force: true });
      return { t1, kinds1, second, state };
    };
    const hidden = [];
    const probe = makeRoom();
    probe.pos = [14, 9];
    for (let y = 0; y < room.length; y++) for (let x = 0; x < room[0].length; x++) {
      if (room[y][x] === '.' && !sees(probe.dungeon, probe.pos, [x, y])) hidden.push([x, y]);
    }
    const A = await run(hidden[0]);
    const B = await run(hidden.at(-1));
    const rem = A.state.threats.remembered;
    if (rem.length !== 1 || rem[0].id !== 'a1' || rem[0].last_seen_steps_ago !== 1 || rem[0].was_chasing !== true) fail(`remembered threat: ${JSON.stringify(rem)}`);
    else if (rem[0].direction !== 'north-west' || !(rem[0].distance >= 9)) fail(`remembered threat direction/distance: ${JSON.stringify(rem[0])}`);
    if (A.state.threats.visible.length) fail('remembered: an unseen adversary is listed as visible');
    if (A.second !== B.second) fail('remembered twin: requests changed when the hidden adversary moved after the sighting');
    if (A.t1.decision?.trigger !== 'encounter' || A.kinds1 !== 'sentiment,tick') fail(`start with an adversary in sight: trigger ${A.t1.decision?.trigger}, requests ${A.kinds1} (want one merged encounter decision)`);
    console.log(`remembered threats: frozen at the sighting (${JSON.stringify(rem[0])}), twin requests byte-identical; start + encounter merged into one sentiment call`);
  }

  // (a2) A remembered sighting expires: seen empty from within sight range, or after 30 steps.
  {
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const g = makeRoom();
    const brain = new ExplorerBrain(new KnownWorld(g), { ask: answerWith((k, ds) => ds[0]), memoryDir: pathToFileURL(dir + '/') });
    g.adversaries = [chaser([8, 2])];
    await brain.takeTurn();
    g.pos = [14, 9];
    g.adversaries = [];
    await brain.takeTurn();
    if (brain.lastRequest().state.threats.remembered.length !== 1) fail('remembered threat missing right after the sighting');
    g.pos = [6, 2]; // 2 cells from the frozen cell, clear line of sight: it is empty now
    await brain.takeTurn();
    if (brain.lastRequest().state.threats.remembered.length) fail('remembered threat not dropped after its cell was seen empty');
    // Age: re-sight, walk away out of range, wait past 30 steps.
    g.adversaries = [chaser([8, 2])]; g.pos = [3, 2];
    await brain.takeTurn();
    g.adversaries = [];
    g.pos = [14, 9];
    await brain.takeTurn();
    if (brain.lastRequest().state.threats.remembered.length !== 1) fail('second sighting not remembered');
    g.steps += 31;
    await brain.takeTurn();
    if (brain.lastRequest().state.threats.remembered.length) fail('remembered threat not dropped after 30 steps');
    rmSync(dir, { recursive: true, force: true });
    console.log('remembered threats expire: seen empty, 30 steps');
  }

  // (b) Move facts toward / away from a sighting, and exploration targets that avoid it.
  {
    const strip = ['#'.repeat(32), '#' + '.'.repeat(30) + '#', '#'.repeat(32)];
    const g = handGame(strip, [6, 1]);
    g.steps = 10;
    const sighting = { id: 'a1', cell: [3, 1], step: 7, chasing: true };
    const moves = describeMoves(new KnownWorld(g), 'nearest_frontier', { remembered: [sighting] });
    if (!/^.*Heads toward where a chasing adversary was last seen 3 steps ago \(2 steps from that spot after this\)\./.test(moves.left)) fail(`sighting fact (toward): ${moves.left}`);
    if (!/Moves away from where a chasing adversary was last seen 3 steps ago \(4 steps from that spot after this\)\./.test(moves.right)) fail(`sighting fact (away): ${moves.right}`);
    const far = describeMoves(new KnownWorld(g), 'nearest_frontier', { remembered: [{ ...sighting, cell: [28, 1] }] });
    if (/last seen/.test(far.left + far.right)) fail('sighting fact for a spot more than 8 steps away');

    // Two equally near edges; the one by the sighting is skipped while the other exists.
    const w = handGame(strip, [14, 1]);
    // Lit columns 4..24: both edges are 10 steps away, so the 10-step zone round one leaves the other.
    for (let x = 0; x < 32; x++) w.light[1][x] = x >= 4 && x <= 24 ? 1 : 0;
    w.light[0] = w.light[0].map((v, x) => (x >= 4 && x <= 24 ? 1 : 0));
    w.light[2] = w.light[2].map((v, x) => (x >= 4 && x <= 24 ? 1 : 0));
    const world = new KnownWorld(w);
    const base = approachTarget(world, 'nearest_frontier');
    const spot = { id: 'a1', cell: base.cell, step: w.steps, chasing: false };
    const zone = avoidZone(world, [spot]);
    for (const id of ['nearest_frontier', 'largest_unexplored', 'far_side']) {
      const t = approachTarget(world, id, { avoid: zone });
      if (zone.has(`${t.cell}`)) fail(`${id} headed into a recent sighting zone: ${t.cell}`);
    }
    const old = avoidZone(world, [{ ...spot, step: w.steps - 16 }]);
    if (old.size) fail('a sighting older than 15 steps still steers targets');
    const everything = new Set(Array.from({ length: 32 }, (_, x) => `${x},1`));
    if (!approachTarget(world, 'nearest_frontier', { avoid: everything })) fail('with every edge in the zone, no target is left (must fall back to the edges)');
    console.log('sighting move facts (toward / away / >8 steps silent) and avoid zone for the three exploration approaches ok');
  }

  // (c) Back and forth: the fact on the undoing move, and tactic_failed with the cooldown.
  {
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const g = makeRoom();
    let turnNo = 0;
    const ask = answerWith((k, ds) => {
      if (k === 'sentiment') return 'bold';
      if (k === 'tactic') return ds.find((d) => d !== 'run_away') ?? ds[0];
      const want = turnNo % 2 === 1 ? 'right' : 'left';
      return ds.includes(want) ? want : ds[0];
    });
    g.adversaries = [chaser([9, 2])];
    const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
    const triggers = [];
    let factSeen = null, preFail = null;
    for (turnNo = 1; turnNo <= 8; turnNo++) {
      const before = brain.memory.recent.back_and_forth;
      const t = await withSeed(turnNo, () => brain.takeTurn());
      if (t.decision) triggers.push(`${turnNo}:${t.decision.trigger}`);
      if (t.decision?.trigger === 'tactic_failed' && preFail === null) preFail = before;
      for (const q of Object.values(brain.lastRequests().at(-1).questions)) {
        for (const text of Object.values(q.criteria ?? {})) if (/Goes back to the cell you left 2 steps ago \(back-and-forth/.test(text)) factSeen = text;
      }
      if (!g.adversaries.length) break;
    }
    if (!factSeen) fail('back-and-forth fact never shown on the undoing move');
    if (preFail === null) fail(`tactic_failed never raised by back-and-forth: ${triggers}`);
    else if (preFail < 3) fail(`tactic_failed raised with back_and_forth ${preFail} < 3`);
    const gaps = triggers.filter((t) => t.endsWith('tactic_failed')).map((t) => Number(t.split(':')[0]));
    if (gaps.some((n, i) => i && n - gaps[i - 1] < 3)) fail(`tactic_failed ignored the re-decision cooldown: ${triggers}`);
    const rec = brain.lastRequest().state.recent;
    if (!Array.isArray(rec.path) || rec.path.length > 6 || !rec.path.every((w) => ['north', 'south', 'east', 'west', 'stay'].includes(w))) fail(`recent.path ${JSON.stringify(rec.path)}`);
    if (!(rec.back_and_forth >= 3)) fail(`recent.back_and_forth ${rec.back_and_forth}`);
    rmSync(dir, { recursive: true, force: true });
    console.log(`back-and-forth: fact on the undoing move, tactic_failed after ${preFail} undone moves (decisions ${triggers.join(' ')})`);
  }

  // (d) Landmarks: dedupe by kind + cell, exit pinned, oldest other evicted; events and counters.
  {
    const mem = createMemory({ approachId: 'nearest_frontier', approachText: 'x', thought: 'x', sentiment: { id: 'steady' }, start: [1, 1] });
    addLandmark(mem, { kind: 'exit', cell: [9, 9], step: 1, note: 'exit' });
    addLandmark(mem, { kind: 'hit_here', cell: [2, 2], step: 2, note: 'first' });
    addLandmark(mem, { kind: 'hit_here', cell: [2, 2], step: 5, note: 'again' });
    if (mem.landmarks.length !== 2 || mem.landmarks.at(-1).step !== 5 || mem.landmarks.at(-1).note !== 'again') fail(`landmark dedupe: ${JSON.stringify(mem.landmarks)}`);
    for (let i = 0; i < 12; i++) addLandmark(mem, { kind: 'dead_end_explored', cell: [i + 3, 3], step: 10 + i, note: `d${i}` });
    if (mem.landmarks.length !== LIMITS.landmarks) fail(`landmark cap ${mem.landmarks.length}`);
    if (!mem.landmarks.some((l) => l.kind === 'exit')) fail('exit landmark was evicted');
    if (mem.landmarks.some((l) => l.kind === 'hit_here') || mem.landmarks.some((l) => l.note === 'd0')) fail('oldest non-exit landmarks were not evicted first');
    if (mem.landmarks.at(-1).note !== 'd11') fail('newest landmark missing');
    validateMemory(mem);
    for (let i = 0; i < 10; i++) addEvent(mem, i + 1, `event ${i}`);
    if (mem.events.length !== LIMITS.events || mem.events[0].text !== 'event 4') fail(`events cap: ${JSON.stringify(mem.events)}`);
    validateMemory(mem);
    const g = makeRoom();
    const sit = situation(new KnownWorld(g), { landmarks: [{ kind: 'exit', cell: [2, 2], step: 0, note: 'The portal.' }, { kind: 'hit_here', cell: [6, 2], step: 0, note: 'Took a hit here.' }] });
    const lm = sit.surroundings.landmarks;
    if (lm[0].direction !== 'here' || lm[1].direction !== 'east' || lm[1].distance !== 4 || lm[1].steps_ago !== g.steps) fail(`landmark view ${JSON.stringify(lm)}`);
    console.log('landmarks: dedupe, 8-cap with the exit pinned, relative view; events capped at 6');
  }

  // (e) Brain: encounter counters, events (no spam, no repeated step), hit landmark, request size.
  {
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const g = makeRoom();
    sizes.length = 0;
    const ask = answerWith((k, ds) => (k === 'sentiment' ? 'bold' : k === 'tactic' ? (ds.find((d) => d !== 'run_away') ?? ds[0]) : ds[0]));
    const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
    const m = brain.memory;
    await brain.takeTurn();
    g.adversaries = [chaser([g.pos[0] + 5 > 14 ? g.pos[0] - 5 : g.pos[0] + 5, g.pos[1]])];
    for (let i = 0; i < 3; i++) await brain.takeTurn();
    g.adversaries = [];
    for (let i = 0; i < 8; i++) await brain.takeTurn();
    if (m.encounters.count !== 1 || m.encounters.escaped !== 1 || m.encounters.last_at_step < 1) fail(`encounters ${JSON.stringify(m.encounters)}`);
    if (m.events.some((e) => /spotted|got away/i.test(e.text))) fail(`event spam: ${JSON.stringify(m.events)}`);
    await brain.noteHit('a1');
    await brain.noteHit('a1');
    if (m.encounters.hits !== 2) fail(`hits ${m.encounters.hits}`);
    if (m.landmarks.filter((l) => l.kind === 'hit_here').length !== 1) fail(`hit_here not deduped: ${JSON.stringify(m.landmarks)}`);
    if (!m.events.some((e) => /^Hit by a1/.test(e.text))) fail('hit event missing');
    for (const e of m.events) if (new RegExp(`\\bstep ${e.step}\\b`).test(e.text)) fail(`event repeats its step: ${JSON.stringify(e)}`);
    validateMemory(m);
    for (const k of ['latest_action', 'findings', 'danger', 'objective']) if (k in m) fail(`memory still has ${k}`);
    const state = brain.lastRequest().state;
    if (Object.keys(state).join() !== 'game,self,surroundings,threats,plan,recent') fail(`state keys ${Object.keys(state)}`);
    const max = Math.max(...sizes.map((s) => s.bytes));
    const maxTactics = Math.max(...sizes.map((s) => s.tactics));
    if (max > 9500) fail(`largest stubbed request is ${max} bytes (> 9500)`);
    // The busiest decision ticks on a hand-built map where almost every tactic is feasible: a seen portal
    // behind a corner, a side room to hide in, an adversary that is chasing (5 tactics) or patrolling (6).
    {
      const hall = [
        '###########################',
        '#........########.........#',
        '#........########.........#',
        '#.........................#',
        '#........####.....#########',
        '#........####.....#########',
        '#........####.....#########',
        '###########################',
      ];
      // slip_past no longer routes to the portal (it is a wall to every non-leaving route), so the hall offers
      // one tactic fewer than before P1: run_away, engage, hide, race_to_exit (+ carry_on while patrolling).
      for (const [mode, wantTactics, bound] of [['chase', 4, 9500], ['patrol', 5, 10500]]) {
        const big = handGame(hall, [5, 3], 12);
        big.dungeon.treasure = [1, 1];
        big.adversaries = [chaser([1, 5], mode)];
        sizes.length = 0;
        const bd = mkdtempSync(join(tmpdir(), 'jev-check-'));
        const bb = new ExplorerBrain(new KnownWorld(big), { ask: answerWith((k, ds) => (k === 'sentiment' ? 'bold' : ds[0])), memoryDir: pathToFileURL(bd + '/') });
        for (let i = 0; i < 3; i++) await bb.takeTurn();
        const peak = Math.max(...sizes.map((s) => s.bytes)), most = Math.max(...sizes.map((s) => s.tactics));
        if (most < wantTactics) fail(`size check (${mode}): only ${most} tactics offered, wanted ${wantTactics}`);
        if (peak > bound) fail(`busiest decision request (${mode}) is ${peak} bytes with ${most} tactics (> ${bound})`);
        console.log(`  busiest decision tick (${mode}): ${peak} bytes with ${most} tactics offered (bound ${bound})`);
        rmSync(bd, { recursive: true, force: true });
      }
    }
    // The worst case after PLAN-motivation P1-P3: every tactic feasible (slip_past to a dark corridor past the
    // ghost, hide, engage with the sword ready, race_to_exit to a lit portal, carry_on while patrolling), lit coin
    // piles within 8 steps, a second ghost remembered, two hits and a full plan.tried in memory, the boldest mood (min gap 2).
    {
      const wide = [
        '################################',
        '#..........####.................#',
        '#..........####.................#',
        '#..........####.................#',
        '#...............................#',
        '#..........####.................#',
        '#..........#####################',
        '#..........#####################',
        '#...............................#',
        '#####.##########################',
        '#####.##########################',
        '#####...........################',
        '################################',
      ];
      const start = [5, 4], ghost = [1, 7];
      // The boldest mood (smallest min gap) by value, not by name, so a mood rename keeps every tactic open.
      const boldest = Object.entries(SENTIMENTS).sort((a, b) => a[1].min_gap - b[1].min_gap)[0][0];
      for (const [mode, wantTactics, bound] of [['chase', 5, 9500], ['patrol', 6, 10500]]) {
        const big = handGame(wide, start, 13);
        big.light = big.light.map((row, y) => row.map((v) => (y <= 9 ? v : 0)));
        big.dungeon.treasure = [1, 1];
        big.coinPiles = [[3, 3], [3, 3], [7, 2], [2, 6], [2, 6], [2, 6]];
        const bd = mkdtempSync(join(tmpdir(), 'jev-check-'));
        const bb = new ExplorerBrain(new KnownWorld(big), {
          ask: answerWith((k, ds) => (k === 'sentiment' ? boldest : k === 'skill' ? 'none' : ds.includes('stay') ? 'stay' : ds[0])),
          memoryDir: pathToFileURL(bd + '/'),
        });
        await withSeed(1, async () => {
          big.pos = [5, 8]; big.adversaries = [chaser([11, 8], 'chase', 'a2')]; // seen, then remembered (out of sight from the start)
          await bb.takeTurn();
          big.pos = [...start]; big.adversaries = [];
          for (let i = 0; i < 4; i++) { await bb.takeTurn(); big.pos = [...start]; }
          await bb.noteHit('a2'); await bb.noteHit('a2');
          // A full plan.tried (5 review switches), as late in a long game; the tactic request leaves it out.
          bb.memory.approach.tried = Array.from({ length: LIMITS.triedApproaches }, (_, i) => ({ id: ['nearest_frontier', 'far_side', 'largest_unexplored'][i % 3], approach: 'x', steps: `${i * 9}–${i * 9 + 8}`, reason: 'Jev judged it not working (31%): 4 cells revealed in 8 steps, 2 revisits in the last 10.' }));
          big.adversaries = [chaser(ghost, mode)];
          sizes.length = 0;
          for (let i = 0; i < 3; i++) { await bb.takeTurn(); big.pos = [...start]; big.adversaries[0].pos = [...ghost]; }
        });
        const peak = Math.max(...sizes.map((s) => s.bytes)), most = Math.max(...sizes.map((s) => s.tactics));
        const last = bb.lastRequests().find((r) => r.questions?.tactic) ?? bb.lastRequest();
        if (most < wantTactics) fail(`worst-case size check (${mode}): only ${most} tactics offered, wanted ${wantTactics}`);
        if (!last.state.threats.remembered.length || !last.state.surroundings.coins) fail(`worst-case size check (${mode}): no remembered ghost or no coins in the state`);
        if (peak > bound) fail(`worst-case decision request (${mode}) is ${peak} bytes with ${most} tactics (> ${bound})`);
        console.log(`  worst-case decision tick (${mode}, coins, remembered ghost, portal): ${peak} bytes with ${most} tactics offered (bound ${bound})`);
        rmSync(bd, { recursive: true, force: true });
      }
    }
    console.log(`encounter counters ${JSON.stringify(m.encounters)}, events ${m.events.length}; ${sizes.length} requests, largest ${max} bytes (up to ${maxTactics} tactics offered)`);
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4e-skills. Fog of skill facts: a VISIBLE ghost's stun and cooldowns never reach Jev, so scrambling them
//     leaves every request byte-identical (the `skill` question included). Its health bar (hp) is seen
//     (user-approved amendment of rule 1), so a different hp must change the request; an UNSEEN ghost's hp
//     must not. After a dispel the ghost is not in threats.remembered. Stub Jev, no network, temp memory dir.
{
  const room = [
    '###########',
    '#.........#',
    '#.........#',
    '#.........#',
    '#.........#',
    '#.........#',
    '###########',
  ];
  const seeded = async (n, fn) => {
    const real = Math.random;
    Math.random = rng(n);
    try { return await fn(); } finally { Math.random = real; }
  };
  let bodies = [];
  const ask = (strike) => async ({ body, questions }) => {
    bodies.push(body);
    return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      if (q.type === 'noul') return [k, { noul: 0.9 }];
      const keys = Object.keys(q.criteria);
      const c = k === 'skill' && strike ? (keys.find((x) => x !== 'none') ?? 'none') : keys[0];
      return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
    }));
  };
  // Scrambles the private state of a ghost without moving it: hit points and stun (and its skill cooldowns,
  // when the ghost exposes a skill set), then puts it back where it stood.
  // A 3-hp ghost hit once (2 of 3 hp, put back where it stood). `stunned`: the stun and its skill
  // cooldowns stay on (the private state); otherwise the stun is ticked away first.
  const hurt = (a, stunned) => {
    const at = [...a.pos];
    a.takeHit(1, [at[0] - 1, at[1]]);
    a.pos = at;
    if (!stunned) { while (a.tickStun()); return; }
    const ks = a.skills?.skills ?? a.skillSet?.skills;
    if (Array.isArray(ks)) for (const k of ks) k.markUsed?.(0);
  };
  // Adjacent ghost: the gate opens and the attack is offered. variant: 'calm' (2 of 3 hp), 'stunned' (2 of 3 hp,
  // stunned, claw on cooldown) or 'fresh' (3 of 3 hp).
  const adj = async (variant) => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    bodies = [];
    const g = handGame(room, [2, 3]);
    g.adversaries = [new Adversary({ id: 'a1', pos: [3, 3], mode: 'chase', hp: 3 })];
    if (variant !== 'fresh') hurt(g.adversaries[0], variant === 'stunned');
    const brain = new ExplorerBrain(new KnownWorld(g), { ask: ask(false), memoryDir: pathToFileURL(dir + '/') });
    await seeded(1, () => brain.takeTurn());
    const out = { bodies: [...bodies], reqs: brain.lastRequests() };
    rmSync(dir, { recursive: true, force: true });
    return out;
  };
  const A = await adj('calm'), B = await adj('stunned'), F = await adj('fresh');
  const skillQ = (r) => r.reqs.map((x) => x.questions?.skill).find(Boolean);
  if (!skillQ(A)) fail('skill twin: no skill question with a visible adjacent ghost');
  else {
    if (!Object.keys(skillQ(A).criteria).some((k) => k.startsWith('sword_strike_'))) fail(`skill twin: no strike option: ${Object.keys(skillQ(A).criteria)}`);
    if (JSON.stringify(skillQ(A)) !== JSON.stringify(skillQ(B))) fail(`skill twin: skill question depends on a visible ghost's private state: ${firstDiff(skillQ(A), skillQ(B))}`);
  }
  if (A.bodies.join('|') !== B.bodies.join('|')) fail(`skill twin: requests depend on a visible ghost's private state: ${firstDiff(A.bodies.map((b) => JSON.parse(b)), B.bodies.map((b) => JSON.parse(b)))}`);
  // The health bar is seen: 2 of 3 hp and 3 of 3 hp must read differently, in threats.visible and the strike option.
  {
    const hpOf = (r) => r.reqs[0]?.state?.threats?.visible?.[0]?.hp;
    if (hpOf(A) !== '2 of 3 hp' || hpOf(F) !== '3 of 3 hp') fail(`health bar: threats.visible hp ${hpOf(A)} / ${hpOf(F)}`);
    const strike = (r) => Object.entries(skillQ(r)?.criteria ?? {}).find(([k]) => k.startsWith('sword_strike_'))?.[1] ?? '';
    if (!/a1 \(2 of 3 hp\) is knocked back and stunned/.test(strike(A))) fail(`health bar: strike fact ${strike(A)}`);
  }
  // An UNSEEN ghost's hp never reaches Jev: behind a wall, 1 hp vs 3 hp, byte-identical requests.
  {
    const walled = ['###########', '#....#....#', '#....#....#', '#....#....#', '###########'];
    const unseen = async (hp) => {
      const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
      bodies = [];
      const g = handGame(walled, [2, 2]);
      g.adversaries = [new Adversary({ id: 'a1', pos: [8, 2], mode: 'patrol', hp })];
      const brain = new ExplorerBrain(new KnownWorld(g), { ask: ask(false), memoryDir: pathToFileURL(dir + '/') });
      await seeded(1, () => brain.takeTurn());
      rmSync(dir, { recursive: true, force: true });
      return [...bodies];
    };
    const u1 = await unseen(1), u3 = await unseen(3);
    if (u1.join('|') !== u3.join('|')) fail(`health bar: an unseen ghost's hp reaches Jev: ${firstDiff(u1.map((b) => JSON.parse(b)), u3.map((b) => JSON.parse(b)))}`);
    if (u1.some((b) => /\bhp\b/.test(JSON.parse(b).state.threats ? JSON.stringify(JSON.parse(b).state.threats) : ''))) fail('health bar: hp in threats with nothing in sight');
  }
  const maxAdj = Math.max(...A.bodies.map((b) => Buffer.byteLength(b, 'utf8')));
  if (maxAdj > 9500) fail(`adjacent-ghost request is ${maxAdj} bytes (> 9500)`);
  console.log(`  adjacent ghost + skill question: ${A.bodies.length} requests, largest ${maxAdj} bytes (skill question ${JSON.stringify(skillQ(A) ?? {}).length} bytes)`);

  // A life lost during a tactic asks again next tick (engage never fails by gap on its own): trigger 'hit'.
  {
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const g = handGame(room, [2, 3]);
    g.adversaries = [new Adversary({ id: 'a1', pos: [7, 3], mode: 'chase' })];
    const pickAsk = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      if (q.type === 'noul') return [k, { noul: 0.9 }];
      const keys = Object.keys(q.criteria);
      const c = k === 'sentiment' ? 'bold' : k === 'tactic' ? (keys.includes('engage') ? 'engage' : keys[0]) : k === 'skill' ? 'none' : keys[0];
      return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
    }));
    const brain = new ExplorerBrain(new KnownWorld(g), { ask: pickAsk, memoryDir: pathToFileURL(dir + '/') });
    await seeded(3, () => brain.takeTurn());
    if (brain.memory.approach.id !== 'engage') fail(`hit re-decision: engage not taken (${brain.memory.approach.id})`);
    else {
      await brain.noteHit('a1');
      const t2 = await seeded(4, () => brain.takeTurn());
      if (t2.decision?.trigger !== 'hit') fail(`hit re-decision: next tick's trigger is ${t2.decision?.trigger ?? 'none'}`);
    }
    rmSync(dir, { recursive: true, force: true });
  }

  // Dispel: one strike on a 1-hp ghost removes it; the next request lists it neither as visible nor remembered.
  {
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    bodies = [];
    const g = handGame(room, [2, 3]);
    // A spare patrolling ghost out of sight (7.3 cells away): dispelling the LAST ghost wins the game, which would end the test.
    g.adversaries = [chaser([3, 3]), chaser([9, 5], 'patrol', 'a2')];
    const ghost = g.adversaries[0];
    // Bring it to 1 hp, then stand it next to the explorer again (a hit knocks it back).
    while (ghost.hp > 1) ghost.takeHit(1, [2, 3]);
    ghost.pos = [3, 3];
    // The strike's own step stays put (`stay`), so the coin it drops (chance 1 here) lies next to the explorer;
    // the next step goes right, onto the pile.
    const step = (dir) => async ({ body, questions }) => {
      bodies.push(body);
      return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
        if (q.type === 'noul') return [k, { noul: 0.9 }];
        const keys = Object.keys(q.criteria);
        const c = k === 'skill' ? (keys.find((x) => x !== 'none') ?? 'none') : keys.includes(dir) ? dir : keys[0];
        return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
      }));
    };
    const chance = skillConfig().coinDropChance;
    configureSkills({ ...skillConfig(), coinDropChance: 1 });
    let next = 'stay';
    const brain = new ExplorerBrain(new KnownWorld(g), { ask: (x) => step(next)(x), memoryDir: pathToFileURL(dir + '/') });
    const t1 = await seeded(1, () => brain.takeTurn());
    const sq = brain.lastRequests().map((r) => r.questions?.skill).find(Boolean);
    if (!sq || /Choose `none` unless/.test(sq.instructions.question)) fail(`skill question: not the neutral explorer wording: ${sq?.instructions?.question}`);
    if (g.adversaries.some((a) => a.id === 'a1')) fail(`dispel: the ghost is still in the game after a strike (skill_decision ${JSON.stringify(t1.skill_decision)})`);
    else {
      next = 'right';
      const t2d = await seeded(2, () => brain.takeTurn());
      // `dispelled` is pending; an encounter-ending chase_over on the same tick wins it (one sentiment call, the merge rule).
      if (!['dispelled', 'chase_over'].includes(t2d.decision?.trigger)) fail(`dispel: the tick after a dispel has trigger ${t2d.decision?.trigger ?? 'none'}, expected dispelled (or chase_over merged)`);
      const st = brain.lastRequest().state;
      const th = st.threats;
      if (th.remembered.length || th.visible.length) fail(`dispel: the dispelled ghost is still listed: ${JSON.stringify(th)}`);
      if (!brain.memory.events.some((e) => e.text === 'Dispelled a1; it dropped a coin.')) fail(`dispel: no dispel event with the coin in memory: ${JSON.stringify(brain.memory.events)}`);
      if (brain.memory.encounters.dispelled !== 1) fail(`dispel: encounters.dispelled ${brain.memory.encounters.dispelled}`);
      if (st.self.coins !== 0 || JSON.stringify(st.surroundings.coins) !== '[{"direction":"east","distance":1,"count":1}]') fail(`coins: self ${st.self.coins}, surroundings ${JSON.stringify(st.surroundings.coins)}`);
      if (!/may drop a coin/.test(st.game) || /every time/.test(st.game)) fail(`coins: rules sentence lacks the drop clause: ${st.game}`);
      if (g.coins !== 1 || brain.memory.progress.coins !== 1 || !brain.memory.events.some((e) => e.text === 'Picked up a coin: 1 in all.')) fail(`coins: pickup not recorded (game ${g.coins}, memory ${brain.memory.progress.coins}, events ${JSON.stringify(brain.memory.events)})`);
      validateMemory(brain.memory);
      console.log('skill fog twin: requests byte-identical with a visible ghost\'s stun and cooldowns scrambled; its health bar read, an unseen one\'s not; dispel counted, its coin seen and picked up');
    }
    configureSkills({ ...skillConfig(), coinDropChance: chance });
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4f. Two behaviours with a SMART stub Jev (deterministic, no network): it reads the move sentences the
//     way the priorities tell Jev to. (a) Under run_away in a room the explorer must not bounce between two
//     cells (the escape spot is kept until reached or unsafe, and a new one is picked by distance, not
  //     the next cell over). (b) After
//     chase_over the explorer must not walk back toward the frozen sighting while another frontier exists.
{
  const BAD = /Moves toward|below your minimum|Steps into/;
  // Like Jev, it reads a speculative move_if_<tactic> option together with that move's shared facts
  // (`surroundings.moves`, sent once beside the per-tactic questions).
  const smartAsk = (mood) => async ({ questions, state }) => {
    const shared = state?.surroundings?.moves ?? {};
    const answers = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') { answers[k] = { noul: 0.9 }; continue; }
      const ids = Object.keys(q.criteria);
      let c = ids[0];
      if (k === 'sentiment') c = mood;
      else if (k === 'tactic') c = ids.includes('run_away') ? 'run_away' : ids[0];
      else {
        // Not a step into or toward an adversary, then toward the approach target, then the largest gap, then no undoing.
        const score = (t) => {
          const away = /Moves away from the chasing adversary[^.]*\((\d+) steps? between/.exec(t);
          const same = /Keeps the same distance from the chasing adversary[^.]*\((\d+) steps? between/.exec(t);
          return (BAD.test(t) ? -1000 : 0) +
            (/Closer to the target|Reaches the target/.test(t) ? 100 : 0) + (away ? +away[1] : same ? +same[1] - 0.5 : 0) - (/Goes back/.test(t) ? 1 : 0);
        };
        const moves = ids.filter((d) => d !== STAY);
        const text = (d) => (k.startsWith('move_if_') ? `${shared[d] ?? ''} ${q.criteria[d]}` : q.criteria[d]);
        c = moves.reduce((best, d) => (score(text(d)) > score(text(best)) ? d : best), moves[0]);
      }
      answers[k] = { choice: c, probabilities: { [c]: 1 }, confidence: 1 };
    }
    return answers;
  };
  const withSeed = async (n, fn) => {
    const real = Math.random;
    Math.random = rng(n);
    try { return await fn(); } finally { Math.random = real; }
  };
  // The scripted ghost: a known-map-free BFS over the real tiles at ADVERSARY_SPEED, stopping next to the explorer.
  const walkToward = (g, a, state) => {
    state.budget += 0.6;
    if (state.budget < 1) return;
    state.budget -= 1;
    const tiles = g.dungeon.tiles;
    const to = g.pos, seen = new Map([[a.pos.join(), null]]), queue = [a.pos];
    for (let i = 0; i < queue.length && !seen.has(to.join()); i++) {
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const n = [queue[i][0] + dx, queue[i][1] + dy];
        if (tiles[n[1]]?.[n[0]] !== '.' || seen.has(n.join())) continue;
        seen.set(n.join(), queue[i]);
        queue.push(n);
      }
    }
    let c = to;
    while (seen.get(c.join()) && seen.get(seen.get(c.join()).join())) c = seen.get(c.join());
    if (seen.has(to.join()) && Math.abs(a.pos[0] - to[0]) + Math.abs(a.pos[1] - to[1]) > 1) a.pos = c;
  };

  // (a) Ping-pong under run_away. A 12x5 room with a corridor out of its south wall; the explorer starts
  //     near a wall, the ghost in sight and walking at it (scripted, ADVERSARY_SPEED). Counted over 15 ticks.
  const room = [
    '##############',
    '#............#',
    '#............#',
    '#............#',
    '#............#',
    '#............#',
    '#######.######',
    '#######.######',
    '#######.######',
    '#######.......',
    '##############',
  ];
  const pingPongRuns = [];
  for (const [me, ghost] of [[[12, 1], [9, 2]], [[10, 5], [8, 3]], [[6, 1], [7, 3]], [[6, 1], [9, 4]]]) {
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const g = handGame(room, me);
    g.visits = { [me.join(',')]: 1 };
    const brain = new ExplorerBrain(new KnownWorld(g), { ask: smartAsk('wary'), memoryDir: pathToFileURL(dir + '/') });
    const a = chaser(ghost);
    g.adversaries = [a];
    const cells = [[...g.pos]], ghostState = { budget: 0 }, tactics = new Set();
    for (let t = 0; t < 15; t++) {
      const turn = await withSeed(100 + t, () => brain.takeTurn());
      if (turn.decision?.tactic?.choice) tactics.add(turn.decision.tactic.choice);
      cells.push([...g.pos]);
      walkToward(g, a, ghostState);
    }
    // Ping-pong = moves that step straight back to the cell just left (A-B-A), the count recent.back_and_forth
    // keeps. Turning round once at the end of a run costs one.
    let pp = 0;
    for (let i = 2; i < cells.length; i++) if (cells[i].join() === cells[i - 2].join() && cells[i].join() !== cells[i - 1].join()) pp++;
    pingPongRuns.push(pp);
    if (pp >= 3) fail(`ping-pong under run_away: ${pp} undone moves in 15 ticks from ${me} with the ghost at ${ghost} (tactics ${[...tactics]}): ${cells.map((c) => c.join(',')).join(' ')}`);
    validateMemory(brain.memory);
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`run_away ping-pong (smart stub, 15 ticks, 4 room starts): undone moves (A-B-A) ${pingPongRuns.join(', ')} (bound < 3 each)`);

  // (a2) The pieces behind it: the escape spot is sticky, a bounce rules cells out, and the run goes on
  //      from the frozen sighting once the adversary is out of sight.
  {
    const g = handGame(room, [11, 3]);
    const world = new KnownWorld(g);
    const spots = [];
    for (const ghost of [[6, 3], [6, 2], [7, 4], [6, 4]]) {
      g.adversaries = [chaser(ghost)];
      const first = approachTarget(world, 'run_away', { minGap: 3 });
      const kept = approachTarget(world, 'run_away', { minGap: 3, goal: spots[0]?.cell ?? first.cell });
      spots.push(first);
      if (spots.length > 1 && `${kept.cell}` !== `${spots[0].cell}`) fail(`run_away goal not kept: ${spots[0].cell} became ${kept.cell} with the ghost at ${ghost}`);
    }
    const cell = spots[0].cell;
    const other = approachTarget(world, 'run_away', { minGap: 3, goal: cell, exclude: new Set([`${cell}`]) });
    if (!other || `${other.cell}` === `${cell}`) fail(`excluded escape spot ${cell} picked again`);
    g.adversaries = [];
    const frozen = { id: 'a1', cell: [6, 3], step: g.steps, chasing: true };
    const carry = approachTarget(world, 'run_away', { minGap: 3, goal: cell, remembered: [frozen] });
    if (`${carry?.cell}` !== `${cell}`) fail(`run_away did not keep its goal once the adversary was out of sight: ${JSON.stringify(carry)}`);
    g.pos = [...cell];
    const next = approachTarget(world, 'run_away', { minGap: 3, goal: cell, remembered: [frozen] });
    if (!next || next.steps < 4 || `${next.cell}` === `${cell}`) fail(`after reaching the spot the run must go on from the frozen sighting: ${JSON.stringify(next)}`);
    if (approachTarget(world, 'run_away', { minGap: 3, goal: cell }) !== null) fail('run_away with no adversary and no sighting must have no target');
    console.log(`run_away target: kept over ${spots.length} ghost positions, excluded cell dropped, carried on from the frozen sighting`);
  }

  // (b) After chase_over, do not walk back toward the frozen sighting while another frontier exists.
  {
    const hall = ['#'.repeat(60), ...Array(3).fill('#' + '.'.repeat(58) + '#'), '#'.repeat(60)];
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const g = handGame(hall, [26, 2]);
    // Lit columns 4..50: a west edge 22 steps away and an east edge 24 away (the west one is nearer).
    g.light = g.light.map((row) => row.map((_, x) => (x >= 4 && x <= 50 ? 1 : 0)));
    g.visits = { '26,2': 1 };
    const world = new KnownWorld(g);
    const brain = new ExplorerBrain(world, { ask: smartAsk('greedy'), memoryDir: pathToFileURL(dir + '/') });
    const spot = [20, 2];
    g.adversaries = [chaser(spot)];
    await withSeed(7, () => brain.takeTurn());
    g.adversaries = []; // out of sight from now on: only the frozen sighting remains
    const at = (c) => Math.abs(c[0] - spot[0]);
    let over = null, d0 = null;
    const after = [];
    for (let t = 0; t < 14; t++) {
      const turn = await withSeed(200 + t, () => brain.takeTurn());
      if (over === null && turn.decision?.trigger === 'chase_over') { over = turn.step; d0 = at(g.pos); }
      if (over !== null && after.length < 8) after.push(at(g.pos));
    }
    if (over === null) fail('chase_over never happened in the re-meeting scenario');
    else if (after.length < 8 || Math.min(...after) < d0) fail(`after chase_over the explorer walked back toward the sighting: distance ${d0} then ${after}`);
    // The move facts name the way back regardless of distance (the sighting is 10+ steps off, a chasing one < 15 steps old).
    const sight = { id: 'a1', cell: spot, step: g.steps - 4, chasing: true };
    const facts = describeMoves(world, 'nearest_frontier', { remembered: [sight] });
    const toward = g.pos[0] > spot[0] ? 'left' : 'right';
    if (!/^Heads back toward where a chasing adversary was 4 steps ago \(\d+ steps from that spot after this\)\./.test(facts[toward] ?? '')) fail(`no "heads back" fact on the move toward a far chasing sighting: ${facts[toward]}`);
    const off = describeMoves(world, 'nearest_frontier', { remembered: [{ ...sight, step: g.steps - 16 }] });
    if (/Heads back toward/.test(off.left + off.right)) fail('"heads back" fact for a sighting older than 15 steps');
    const calm = describeMoves(world, 'nearest_frontier', { remembered: [{ ...sight, chasing: false }] });
    if (/Heads back toward/.test(calm.left + calm.right)) fail('"heads back" fact for a sighting that was not chasing');
    console.log(`after chase_over (step ${over}) the next ${after.length} moves stay at distance ${Math.min(...after)}+ from the sighting (was ${d0}); "heads back" fact on the way back`);
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4g. The portal and the leave decision (stub Jev, no network, temp memory dir): sighting the portal
//     changes no approach by itself; `leave_now` is asked on the exit tick and in every review once the
//     portal is known, never before; above 0.5 the approach becomes go_to_exit and stays; below, exploring
//     goes on; and the question carries no fact about unlit cells (a twin with hidden coins and tiles).
{
  const corridor = (wallAt = null) => [
    '#'.repeat(40),
    '#' + '.'.repeat(38).split('').map((c, i) => (i + 1 === wallAt ? '#' : c)).join('') + '#',
    '#'.repeat(40),
  ];
  const mk = (lit, wallAt = null, coins = []) => {
    const g = handGame(corridor(wallAt), [2, 1], lit);
    g.dungeon.treasure = [20, 1];
    g.coinPiles = coins;
    return g;
  };
  const play = async (leaveAnswer, ticks) => {
    const g = mk(3);
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const log = [];
    const ask = async ({ questions, body }) => {
      const known = new KnownWorld(g).seenTreasure() !== null;
      log.push({ step: g.steps, known, kinds: Object.keys(questions), body });
      const answers = {};
      for (const [k, q] of Object.entries(questions)) {
        if (q.type === 'noul') answers[k] = { noul: k === 'leave_now' ? leaveAnswer : 0.9 };
        else {
          const keys = Object.keys(q.criteria);
          // walk right until the portal is lit, then stand still (so the game never ends on a step onto it)
          const c = k === 'sentiment' ? 'steady' : known && keys.includes(STAY) ? STAY : keys.includes('right') ? 'right' : keys[0];
          answers[k] = { choice: c, probabilities: { [c]: 1 }, confidence: 1 };
        }
      }
      return answers;
    };
    const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
    const approaches = [];
    for (let i = 0; i < ticks && !g.won; i++) { await brain.takeTurn(); approaches.push(brain.memory.approach.id); }
    rmSync(dir, { recursive: true, force: true });
    return { g, brain, log, approaches };
  };

  // (a) leave_now says 0.1: asked on the exit tick and again in reviews, never before the portal is known,
  //     and the approach is never switched to go_to_exit by sighting alone.
  {
    const { log, approaches, brain } = await play(0.1, 40);
    const asks = log.filter((l) => l.kinds.includes('leave_now'));
    if (asks.some((l) => !l.known)) fail('leave_now asked before the portal was known');
    const firstKnown = log.find((l) => l.known);
    if (!firstKnown) fail('portal never seen in the corridor run');
    else if (!asks.length || asks[0].step !== firstKnown.step) fail(`leave_now not asked on the exit tick (first known at step ${firstKnown?.step}, first ask ${asks[0]?.step})`);
    if (asks.length < 3) fail(`leave_now asked ${asks.length} times; wanted the exit tick plus later reviews`);
    if (log.filter((l) => !l.known).some((l) => l.kinds.includes('leave_now'))) fail('leave_now before sighting');
    if (approaches.some((a) => a === 'go_to_exit')) fail('sighting or a 0.1 answer switched the approach to go_to_exit');
    // leave_now is the only gate into go_to_exit: a review never offers it as next_approach.
    const reviews = log.filter((l) => l.kinds.includes('next_approach'));
    if (!reviews.length) fail('no review asked next_approach in the corridor run');
    if (reviews.some((l) => 'go_to_exit' in JSON.parse(l.body).questions.next_approach.criteria)) fail('next_approach offers go_to_exit');
    if (!brain.memory.landmarks.some((l) => l.kind === 'exit')) fail('exit landmark missing');
    if (!brain.memory.events.concat([]).some((e) => /Saw the portal/.test(e.text)) && brain.memory.events.length < 6) fail('portal sighting event missing');
    console.log(`leave_now at 0.1: asked ${asks.length} times from the exit tick on, approach stayed ${[...new Set(approaches)].join('/')}`);
  }

  // (b) leave_now says 0.9: go_to_exit on the exit tick, and it sticks (no more reviews or leave_now).
  {
    const { log, approaches, g } = await play(0.9, 30);
    const i = approaches.indexOf('go_to_exit');
    if (i < 0) fail('leave_now 0.9 did not switch to go_to_exit');
    else {
      const firstKnown = log.find((l) => l.known).step;
      if (i + 1 !== firstKnown + 1) fail(`switch at tick ${i + 1}, portal asked at step ${firstKnown}`);
      if (approaches.slice(i).some((a) => a !== 'go_to_exit')) fail(`go_to_exit did not stick: ${approaches.slice(i).join(',')}`);
      if (log.filter((l) => l.step > firstKnown).some((l) => l.kinds.includes('leave_now') || l.kinds.includes('approach_working'))) fail('asked again after deciding to leave');
    }
    if (g.won) fail('stub should not have walked onto the portal');
    console.log(`leave_now at 0.9: go_to_exit from tick ${i + 1}, kept for ${approaches.length - i} ticks`);
  }

  // (c) Fog twin: coins and walls on unlit cells differ, the exit-tick request is byte-identical, and
  //     a different LIT coin changes it (the question does read the lit ones).
  {
    const bodyOf = async (g) => {
      const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
      const bodies = [];
      const ask = async ({ questions, body }) => {
        bodies.push(body);
        return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.type === 'noul' ? { noul: 0.1 } : { choice: Object.keys(q.criteria)[0], probabilities: {}, confidence: 1 }]));
      };
      const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
      const real = Math.random;
      Math.random = rng(7);
      try { await brain.takeTurn(); } finally { Math.random = real; }
      rmSync(dir, { recursive: true, force: true });
      return bodies;
    };
    const A = await bodyOf(mk(25, null, [[10, 1], [28, 1]]));
    const B = await bodyOf(mk(25, 30, [[10, 1], [33, 1], [35, 1]]));
    const C = await bodyOf(mk(25, null, [[12, 1], [28, 1]]));
    if (!A.some((b) => b.includes('leave_now'))) fail('leave_now missing from the twin request');
    if (A.join('|') !== B.join('|')) fail('leave_now twin: hidden coins/walls changed the request');
    if (A.join('|') === C.join('|')) fail('leave_now twin: a different lit coin did not change the request');
    const q = JSON.parse(A.find((b) => b.includes('leave_now'))).questions.leave_now;
    if (/treasure|chest/i.test(JSON.stringify(q))) fail('leave_now mentions the old chest words');
    console.log('leave_now fog twin: hidden coins and walls leave the request byte-identical; lit coins show');
  }

  // (d) The corridor repro: the exploration target lies past the seen portal. The portal is a wall for every
  //     non-leaving route, so no approach targets it and a stub following "Closer to the target" never wins.
  {
    const row = '#@..c.T.................#';
    const g = handGame(['#'.repeat(row.length), row.replace('@', '.').replace('c', '.').replace('T', '.'), '#'.repeat(row.length)], [1, 1], 3);
    g.dungeon.treasure = [6, 1];
    g.coinPiles = [[4, 1]];
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const ask = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      if (q.type === 'noul') return [k, { noul: k === 'leave_now' ? 0.1 : 0.9 }];
      const keys = Object.keys(q.criteria);
      // Follows "Closer to the target" literally (the portal step included, if a fact ever points through it); else stays.
      const c = k === 'sentiment' ? 'steady' : keys.find((d) => /Closer to the target/.test(String(q.criteria[d]))) ?? (keys.includes(STAY) ? STAY : keys[0]);
      return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
    }));
    const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
    const portal = g.dungeon.treasure;
    for (let i = 0; i < 20 && !g.won; i++) {
      // Every frontier lies past the portal in this 1-wide corridor, so none is reachable without crossing it.
      if (new KnownWorld(g).seenTreasure() && approachTarget(new KnownWorld(g), 'nearest_frontier')) fail(`nearest_frontier has a target through the portal (tick ${i})`);
      for (const id of ['nearest_frontier', 'largest_unexplored', 'far_side', 'run_away', 'hide', 'carry_on']) {
        const t = approachTarget(new KnownWorld(g), id);
        if (t && t.cell.join() === portal.join()) fail(`${id} targets the portal (tick ${i})`);
      }
      await brain.takeTurn();
    }
    if (g.won) fail('a stub following "Closer to the target" won through the portal by accident');
    rmSync(dir, { recursive: true, force: true });
    console.log('corridor repro: no non-leaving target is the portal; no accidental win in 20 ticks');
  }

  // (e) The portal first seen mid-encounter: leave_now is not asked beside a tactic question; it comes on the
  //     first tick without one.
  {
    const hall = ['#'.repeat(20), '#' + '.'.repeat(18) + '#', '#' + '.'.repeat(18) + '#', '#' + '.'.repeat(18) + '#', '#'.repeat(20)];
    const g = handGame(hall, [3, 2], 9);
    g.dungeon.treasure = [15, 2];
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const log = [];
    const ask = async ({ questions }) => {
      log.push({ known: new KnownWorld(g).seenTreasure() !== null, kinds: Object.keys(questions) });
      return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
        if (q.type === 'noul') return [k, { noul: k === 'leave_now' ? 0.1 : 0.9 }];
        const keys = Object.keys(q.criteria);
        const known = new KnownWorld(g).seenTreasure() !== null;
        const c = k === 'sentiment' ? 'steady' : k === 'tactic' ? (keys.includes('run_away') ? 'run_away' : keys[0]) : known && keys.includes(STAY) ? STAY : keys.includes('right') ? 'right' : keys[0];
        return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
      }));
    };
    const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
    for (let i = 0; i < 12 && !g.won; i++) {
      // A chaser two cells behind, in sight, for the first 7 ticks; then it is gone.
      g.adversaries = i < 7 ? [chaser([Math.max(1, g.pos[0] - 3), g.pos[1]])] : [];
      await brain.takeTurn();
    }
    const tacticWhileKnown = log.some((l) => l.known && l.kinds.includes('tactic'));
    const first = log.find((l) => l.kinds.includes('leave_now'));
    if (!tacticWhileKnown) fail('mid-encounter case: no tactic question after the portal was seen (setup)');
    else if (!first) fail('mid-encounter case: leave_now never asked');
    else if (first.kinds.includes('tactic')) fail('leave_now asked beside a tactic question');
    else if (!first.known) fail('leave_now asked before the portal was known');
    rmSync(dir, { recursive: true, force: true });
    console.log('mid-encounter portal: leave_now waits for the first tick without a tactic question');
  }
}

// 4h. Coins pull (PLAN-motivation P2; stub Jev, no network, temp memory dir): collect_coins is offered only
//     while a lit pile is reachable and targets the best coins per known-path step, never through the portal;
//     unlit piles change no request byte; the per-move "Toward N seen coins" fact shows within 8
//     steps only; the coin decision (a `coins` mood trigger: one sentiment call, then a next_approach question in the same tick) fires once on a new nearby
//     pile, not again within 10 steps, not beside a tactic; a stub picking collect_coins walks onto the pile.
{
  const strip = (n) => ['#'.repeat(n), '#' + '.'.repeat(n - 2) + '#', '#'.repeat(n)];
  const hall = (n) => ['#'.repeat(n), ...Array(3).fill('#' + '.'.repeat(n - 2) + '#'), '#'.repeat(n)];
  const mk = (rows, pos, lit, coins, portal = null) => {
    const g = handGame(rows, pos, lit);
    if (portal) g.dungeon.treasure = portal;
    g.coinPiles = coins;
    return g;
  };
  const seeded = async (n, fn) => {
    const real = Math.random;
    Math.random = rng(n);
    try { return await fn(); } finally { Math.random = real; }
  };

  // (a) Offered only with a lit, reachable pile; the target is the best coins / steps (ties: fewer steps).
  {
    const w = (g) => new KnownWorld(g);
    if (availableApproaches(w(mk(hall(30), [2, 2], 9, []))).includes('collect_coins')) fail('collect_coins offered with no coins');
    if (availableApproaches(w(mk(hall(30), [2, 2], 9, [[20, 2]]))).includes('collect_coins')) fail('collect_coins offered for an unlit pile');
    const lit = w(mk(hall(30), [2, 2], 9, [[5, 2], [8, 2], [8, 2], [8, 2]]));
    if (!availableApproaches(lit).includes('collect_coins')) fail('collect_coins not offered with a lit pile');
    const t = approachTarget(lit, 'collect_coins');
    // 1 coin 3 steps away = 0.33 per step; 3 coins 6 steps away = 0.5 per step
    if (!t || t.cell.join() !== '8,2' || t.count !== 3) fail(`collect_coins target ${JSON.stringify(t)}, expected the 3-coin pile at 8,2`);
    const better = approachTarget(w(mk(hall(30), [2, 2], 9, [[4, 2], [8, 2], [8, 2], [8, 2], [8, 2]])), 'collect_coins'); // 0.5 vs 0.67
    if (better.cell.join() !== '8,2') fail(`collect_coins ignored the better ratio: ${JSON.stringify(better)}`);
    const even = approachTarget(w(mk(hall(30), [2, 2], 9, [[4, 2], [8, 2], [8, 2], [8, 2]])), 'collect_coins'); // 0.5 vs 0.5: fewer steps
    if (even.cell.join() !== '4,2') fail(`collect_coins tie not broken by steps: ${JSON.stringify(even)}`);
    const avoid = approachTarget(lit, 'collect_coins', { avoid: new Set(['8,2']) });
    if (avoid.cell.join() !== '5,2') fail('collect_coins ignored the avoid zone while another pile exists');
    const only = approachTarget(w(mk(hall(30), [2, 2], 9, [[8, 2]])), 'collect_coins', { avoid: new Set(['8,2']) });
    if (!only) fail('collect_coins dropped its only pile for the avoid zone');
    // The portal is a wall: a pile behind it is unreachable, so the approach has no target there.
    const behind = w(mk(strip(30), [2, 1], 12, [[10, 1]], [6, 1]));
    if (availableApproaches(behind).includes('collect_coins') || approachTarget(behind, 'collect_coins')) fail('collect_coins routes through the portal');
    const before = w(mk(strip(30), [2, 1], 12, [[4, 1]], [6, 1]));
    if (approachTarget(before, 'collect_coins')?.cell.join() !== '4,1') fail('collect_coins missed a pile before the portal');
    console.log('collect_coins: offered only with a lit reachable pile; best coins per step (ties: fewer steps); avoid zone honoured; the portal is a wall');
  }

  // (b) The move fact: nearest pile by known path, within 8 steps only.
  {
    const facts = (pileX) => describeMoves(new KnownWorld(mk(strip(30), [3, 1], 14, [[pileX, 1], [pileX, 1]])), 'nearest_frontier');
    const near = facts(11); // 8 steps away
    if (!/Toward 2 seen coins \(7 steps after this\)\./.test(near.right)) fail(`no toward-coins fact at 8 steps: ${near.right}`);
    if (/seen coin/.test(near.left)) fail(`a coins fact on the move away from the pile: ${near.left}`);
    const far = facts(12); // 9 steps away
    if (/seen coin/.test(far.right + far.left)) fail(`coins fact beyond 8 steps: ${far.right} ${far.left}`);
    const on = describeMoves(new KnownWorld(mk(strip(30), [3, 1], 14, [[4, 1], [4, 1]])), 'nearest_frontier');
    if (!/Picks up 2 coins\./.test(on.right) || /Toward/.test(on.right)) fail(`step onto a pile: ${on.right}`);
    const parts = describeMoveParts(new KnownWorld(mk(strip(30), [3, 1], 14, [[11, 1]])), 'collect_coins');
    if (!/Toward 1 seen coin/.test(parts.right.shared) || /seen coin/.test(parts.right.target)) fail('the coins fact is not in the shared part');
    console.log('coin move fact: Toward (only on the closing move) within 8 known-path steps, absent at 9, Picks up on the pile, in the shared part');
  }

  // (c) Fog twin: coins on unlit cells change no request byte; a lit pile does.
  {
    const run = async (coins) => {
      const g = mk(hall(40), [2, 2], 9, coins);
      const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
      const ask = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
        if (q.type === 'noul') return [k, { noul: 0.9 }];
        const keys = Object.keys(q.criteria);
        const c = k === 'sentiment' ? 'steady' : keys.includes('right') ? 'right' : keys[0];
        return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
      }));
      const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
      await seeded(7, () => brain.takeTurn());
      await seeded(8, () => brain.takeTurn());
      const out = JSON.stringify(brain.lastRequests());
      rmSync(dir, { recursive: true, force: true });
      return out;
    };
    const none = await run([]);
    const dark = await run([[30, 2], [35, 1], [30, 2]]);
    if (none !== dark) fail('unlit coins changed the request');
    const lit = await run([[7, 2]]);
    if (lit === none || !/seen coin/.test(lit)) fail('a lit pile did not reach the request');
    console.log('coin fog twin: unlit piles leave the requests byte-identical; a lit pile shows');
  }

  // (d) The coin decision.
  {
    const play = async ({ rows, coins, pick, ticks, ghost = false, pos = [2, 2] }) => {
      const g = mk(rows, pos, 2, coins);
      const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
      const log = [];
      let brain = null;
      const ask = async ({ kind, questions }) => {
        log.push({ step: g.steps, kind, kinds: Object.keys(questions), approach: brain.memory.approach.id });
        return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
          if (q.type === 'noul') return [k, { noul: 0.1 }];
          const keys = Object.keys(q.criteria);
          let c = keys.includes('right') ? 'right' : keys[0];
          if (k === 'sentiment') c = 'steady';
          if (k === 'tactic') c = keys.includes('run_away') ? 'run_away' : keys[0];
          if (k === 'next_approach') c = pick === 'current' ? brain.memory.approach.id : pick;
          return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
        }));
      };
      brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
      const turns = [];
      for (let i = 0; i < ticks && !g.won; i++) {
        if (ghost) g.adversaries = [chaser([Math.max(1, g.pos[0] - 3), g.pos[1]])];
        turns.push(await brain.takeTurn());
      }
      rmSync(dir, { recursive: true, force: true });
      return { g, log, turns, brain };
    };
    const wide = hall(60);

    // Picks collect_coins: one question, a switch, the pile taken, the approach back to the edges, no sentiment call for it.
    const a = await play({ rows: wide, coins: [[11, 2], [11, 2]], pick: 'collect_coins', ticks: 14 });
    const asks = a.log.filter((l) => l.kinds.includes('next_approach') && !l.kinds.includes('approach_working'));
    if (asks.length !== 1) fail(`coin decision asked ${asks.length} times, expected 1`);
    else if (asks[0].kind !== 'tick') fail(`coin decision on the wrong request: ${JSON.stringify(asks[0])}`);
    const sentCalls = a.log.filter((l) => l.kind === 'sentiment');
    if (sentCalls.length !== 2) fail(`expected 2 sentiment calls (start, then the coins trigger), got ${sentCalls.length}`);
    else if (!a.turns.some((t) => t.decision?.trigger === 'coins')) fail('no decision with trigger coins');
    else if (a.log.indexOf(asks[0]) - a.log.indexOf(sentCalls[1]) !== 1) fail('the coin next_approach did not follow its sentiment call in the same tick');
    if (!a.turns.some((t) => t.policy?.to === 'collect_coins')) fail('picking collect_coins did not switch the approach');
    if (a.g.coins !== 2 || a.brain.memory.progress.coins !== 2) fail(`the stub picking collect_coins did not collect the pile (coins ${a.g.coins})`);
    if (!a.turns.some((t) => t.policy?.from === 'collect_coins' && t.policy.to === 'nearest_frontier')) fail('collect_coins did not hand back to nearest_frontier once the pile was taken');
    if (a.brain.memory.approach.id !== 'nearest_frontier') fail(`approach after the coins: ${a.brain.memory.approach.id}`);
    validateMemory(a.brain.memory);

    // Picks the current approach: no switch; a second pile within 10 steps asks nothing more.
    const b = await play({ rows: wide, coins: [[10, 2], [15, 2]], pick: 'current', ticks: 14 });
    const asksB = b.log.filter((l) => l.kinds.includes('next_approach') && !l.kinds.includes('approach_working'));
    if (asksB.length !== 1) fail(`two piles within 10 steps: coin decision asked ${asksB.length} times, expected 1 ${JSON.stringify(asksB)}`);
    if (b.turns.some((t) => t.policy?.to === 'collect_coins')) fail('staying with the current approach still switched');

    // Beside a tactic nothing is asked.
    const c = await play({ rows: wide, coins: [[10, 2]], pick: 'collect_coins', ticks: 10, ghost: true });
    if (c.log.some((l) => l.kinds.includes('next_approach') && (l.kinds.includes('tactic') || TACTICS.includes(l.approach)))) fail('coin decision asked during a tactic');
    if (!c.log.some((l) => l.kinds.includes('tactic'))) fail('tactic setup: no tactic question was asked');
    console.log('coin decision: one coins mood call + next_approach on a new nearby pile, none within 10 steps, none beside a tactic; collect_coins walks onto the pile, then hands back to nearest_frontier');
  }
}

// 4i. Four moods (PLAN-motivation P4): exactly wary/steady/greedy/bold, steady by default, memory accepts only
//     those ids, no mood text pushes for the chest/portal, the mood triggers `coins` and `dispelled` (the latter
//     checked in the dispel test above) fire as specified and merge with an encounter into ONE sentiment call.
{
  const ids = Object.keys(SENTIMENTS).sort().join();
  if (ids !== 'bold,greedy,steady,wary') fail(`SENTIMENTS ids: ${ids}`);
  if (MOOD_IDS.slice().sort().join() !== ids) fail('memory MOOD_IDS differ from SENTIMENTS');
  const mins = Object.fromEntries(Object.entries(SENTIMENTS).map(([k, v]) => [k, `${v.min_gap}/${v.end_ticks}`]));
  if (JSON.stringify(mins) !== JSON.stringify({ wary: '4/5', steady: '3/4', greedy: '3/2', bold: '2/1' })) fail(`mood numbers ${JSON.stringify(mins)}`);
  for (const [id, m] of Object.entries(SENTIMENTS)) {
    for (const f of ['min_gap', 'end_ticks', 'priority', 'move_priority', 'when', 'note', 'skill_priority']) if (m[f] == null) fail(`mood ${id} lacks ${f}`);
    const text = [m.priority, m.move_priority, m.when, m.note, m.skill_priority].join(' ');
    if (/chest|treasure/i.test(text) || /push(es)? for|the goal/i.test(text)) fail(`mood ${id} text mentions the chest or pushing for the goal: ${text}`);
    if (!/Strike an adjacent adversary whenever the sword is ready/.test(m.skill_priority)) fail(`mood ${id} skill_priority lost the strike rule`);
    if (!/Upside/.test(m.when) || !/Risk/.test(m.when)) fail(`mood ${id} when does not name upside and risk`);
  }
  const g0 = handGame(['######', '#....#', '######'], [1, 1]);
  const d0 = mkdtempSync(join(tmpdir(), 'jev-check-'));
  const b0 = new ExplorerBrain(new KnownWorld(g0), { ask: async () => ({}), memoryDir: pathToFileURL(d0 + '/') });
  if (b0.memory.sentiment.id !== 'steady') fail(`default mood ${b0.memory.sentiment.id}`);
  for (const old of ['cautious', 'scared', 'risk_averse', 'curious', 'courageous', 'aggressive']) {
    const m = structuredClone(b0.memory);
    m.sentiment.id = old;
    let threw = false;
    try { validateMemory(m); } catch { threw = true; }
    if (!threw) fail(`memory accepted the old mood ${old}`);
  }
  rmSync(d0, { recursive: true, force: true });

  // The sentiment request: four options, each with upside and risk, the new question wording.
  {
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const g = handGame(['#'.repeat(30), ...Array(3).fill('#' + '.'.repeat(28) + '#'), '#'.repeat(30)], [2, 2], 2);
    const seen = [];
    const ask = async ({ kind, questions, body }) => {
      seen.push({ kind, kinds: Object.keys(questions), bytes: JSON.stringify(body).length, q: questions.sentiment });
      return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
        if (q.type === 'noul') return [k, { noul: 0.1 }];
        const keys = Object.keys(q.criteria);
        const c = k === 'sentiment' ? 'steady' : keys.includes('right') ? 'right' : keys[0];
        return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
      }));
    };
    const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
    await brain.takeTurn();
    const q = seen[0].q;
    if (Object.keys(q.criteria).length !== 4) fail('sentiment question does not have 4 options');
    if (!/What should the explorer go after right now: safety \(wary\), the plan \(steady\), loot \(greedy\) or the fight \(bold\)\?/.test(q.instructions)) fail(`sentiment question wording: ${q.instructions}`);
    console.log(`sentiment request (start): ${seen[0].bytes} bytes, 4 moods`);
    rmSync(dir, { recursive: true, force: true });
  }

  // Trigger `coins`: a first-seen pile within 8 steps asks the mood, then next_approach, in one tick; the
  // cooldown (3 ticks after the start decision) delays it; an encounter on the same tick wins (one sentiment call).
  {
    const wide = ['#'.repeat(60), ...Array(3).fill('#' + '.'.repeat(58) + '#'), '#'.repeat(60)];
    const run = async (ticks, adversaryAt = null) => {
      const g = handGame(wide, [2, 2], 2);
      g.coinPiles = [[11, 2]];
      const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
      const log = [];
      const ask = async ({ kind, questions }) => {
        log.push({ step: g.steps, kind, kinds: Object.keys(questions) });
        return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
          if (q.type === 'noul') return [k, { noul: 0.1 }];
          const keys = Object.keys(q.criteria);
          let c = keys.includes('right') ? 'right' : keys[0];
          if (k === 'sentiment') c = 'steady';
          if (k === 'tactic') c = keys.includes('run_away') ? 'run_away' : keys[0];
          if (k === 'next_approach') c = 'nearest_frontier';
          return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
        }));
      };
      const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
      const turns = [];
      for (let i = 0; i < ticks; i++) {
        if (adversaryAt && i === adversaryAt) g.adversaries = [chaser([Math.max(1, g.pos[0] - 3), g.pos[1]])];
        turns.push(await brain.takeTurn());
      }
      rmSync(dir, { recursive: true, force: true });
      return { log, turns };
    };
    const a = await run(12);
    const ct = a.turns.filter((t) => t.decision?.trigger === 'coins');
    if (ct.length !== 1) fail(`coins trigger fired ${ct.length} times, expected 1`);
    else {
      const startStep = a.turns.find((t) => t.decision?.trigger === 'start').step;
      if (ct[0].step - startStep < 3) fail(`coins trigger ignored the redecide cooldown (start ${startStep}, coins ${ct[0].step})`);
      const at = a.log.map((l, i) => ({ ...l, i })).filter((l) => l.step === ct[0].step - 1);
      if (at.map((l) => l.kind).join() !== 'sentiment,tick' || !at[1].kinds.includes('next_approach')) fail(`coins tick requests ${JSON.stringify(at)}`);
    }
    // An adversary walks in once the pile is due: the encounter decision takes the tick, one sentiment call for it.
    const b = await run(14, 3);
    const perTick = new Map();
    for (const l of b.log) if (l.kind === 'sentiment') perTick.set(l.step, (perTick.get(l.step) ?? 0) + 1);
    if ([...perTick.values()].some((n) => n > 1)) fail(`two sentiment calls on one tick: ${JSON.stringify([...perTick])}`);
    if (!b.turns.some((t) => t.decision?.trigger === 'encounter')) fail('coins+encounter setup: no encounter decision');
    console.log('mood triggers: coins (cooldown, one sentiment call then next_approach), merged with an encounter into one call; dispelled in the dispel test');
  }
  // Trigger `dispelled`: the tick after a dispel (steady stays alert 4 ticks, so chase_over does not take it),
  // with a spare ghost out of sight so the dispel does not win the game.
  {
    const seeded = async (n, fn) => { const real = Math.random; Math.random = rng(n); try { return await fn(); } finally { Math.random = real; } };
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const rows = ['#'.repeat(20), ...Array(9).fill('#' + '.'.repeat(18) + '#'), '#'.repeat(20)];
    const g = handGame(rows, [2, 3]);
    g.adversaries = [chaser([3, 3]), chaser([18, 9], 'patrol', 'a2')];
    while (g.adversaries[0].hp > 1) g.adversaries[0].takeHit(1, [2, 3]);
    g.adversaries[0].pos = [3, 3];
    const log = [];
    const ask = async ({ kind, questions }) => {
      log.push({ step: g.steps, kind, kinds: Object.keys(questions) });
      return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
        if (q.type === 'noul') return [k, { noul: 0.1 }];
        const keys = Object.keys(q.criteria);
        const c = k === 'sentiment' ? 'steady' : k === 'skill' ? (keys.find((x) => x !== 'none') ?? 'none') : k === 'tactic' ? keys[0] : keys.includes('stay') ? 'stay' : keys[0];
        return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
      }));
    };
    const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
    await seeded(3, () => brain.takeTurn());
    if (g.adversaries.some((a) => a.id === 'a1')) fail('dispelled setup: the ghost was not dispelled');
    else {
      log.length = 0;
      const t = await seeded(4, () => brain.takeTurn());
      if (t.decision?.trigger !== 'dispelled') fail(`tick after a dispel: trigger ${t.decision?.trigger ?? 'none'}, expected dispelled`);
      if (log.filter((l) => l.kind === 'sentiment').length !== 1) fail('dispelled tick did not make exactly one sentiment call');
    }
    rmSync(dir, { recursive: true, force: true });
  }

}

// 5. Scripted follower: nearest_frontier until the chest is seen, then go_to_exit,
//    stepping along the known-floor shortest path to the current target. No adversaries.
function knownStepTowards(game, target) {
  const dist = new Map([[target.join(), 0]]);
  const queue = [target];
  for (let i = 0; i < queue.length; i++) {
    for (const [dx, dy] of Object.values(DIRS)) {
      const n = [queue[i][0] + dx, queue[i][1] + dy];
      if (dist.has(n.join()) || !game.isKnown(n) || game.dungeon.tiles[n[1]][n[0]] !== '.') continue;
      dist.set(n.join(), dist.get(queue[i].join()) + 1);
      queue.push(n);
    }
  }
  const here = dist.get(game.pos.join());
  return game.legalMoves().find((dir) => dist.get([game.pos[0] + DIRS[dir][0], game.pos[1] + DIRS[dir][1]].join()) === here - 1) ?? null;
}

function follow(game, cap = 20000, onTick = null) {
  while (!game.won && game.steps < cap) {
    if (onTick) onTick(game);
    const target = approachTarget(new KnownWorld(game), exitSeen(new KnownWorld(game)) ? 'go_to_exit' : 'nearest_frontier');
    if (!target) return false;
    const dir = knownStepTowards(game, target.cell);
    if (!dir) return false;
    game.applyMove(dir);
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
  for (const s of quick) if (!follow(new Game(generateDungeon(s)))) fail(`follower did not win seed ${s}`);
  console.log(`follower: won ${quick.length} quick games`);
}

if (MEASURE) {
  console.log('\n--- measurement (scripted follower, no adversaries) ---');
  let longest = { steps: 0 };
  for (const [label, lo, hi] of [['~35x35', 35, 40], ['~150x150', 140, 150]]) {
    const rows = [];
    for (const s of seedsOfSize(lo, hi, 10)) {
      const g = new Game(generateDungeon(s));
      const t0 = performance.now();
      const won = follow(g);
      rows.push({ s, size: `${g.dungeon.width}x${g.dungeon.height}`, steps: g.steps, won, explored: g.publicView().explored_pct, ms: Math.round(performance.now() - t0) });
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
  const g = new Game(generateDungeon(bigSeed));
  follow(g, Math.floor(longest.steps * 0.9));
  const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  const tick = (approach) => time(() => { situation(new KnownWorld(g)); approachTarget(new KnownWorld(g), approach); describeMoves(new KnownWorld(g), approach); });
  const calm = [], chased = [];
  const floorNear = [];
  for (let i = 0; i < 60 && !g.won; i++) {
    const approach = exitSeen(new KnownWorld(g)) ? 'go_to_exit' : 'nearest_frontier';
    g.adversaries = [];
    calm.push(tick(approach));
    // Put a chaser in sight, a few cells away.
    floorNear.length = 0;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const c = [g.pos[0] + dx, g.pos[1] + dy];
      if ((dx || dy) && g.dungeon.tiles[c[1]]?.[c[0]] === '.' && sees(g.dungeon, g.pos, c)) floorNear.push(c);
    }
    if (floorNear.length) {
      g.adversaries = [new Adversary({ id: 'a1', pos: floorNear.at(-1), mode: 'chase' })];
      chased.push(time(() => { situation(new KnownWorld(g)); approachTarget(new KnownWorld(g), 'run_away'); describeMoves(new KnownWorld(g), 'run_away'); tacticOptions(new KnownWorld(g), 3); }));
    }
    g.adversaries = [];
    const target = approachTarget(new KnownWorld(g), approach);
    const dir = target && knownStepTowards(g, target.cell);
    if (!dir) break;
    g.applyMove(dir);
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
  const g = new Game(d);
  g.adversaries = spawnAdversaries(d);
  const render = (game, reveal) => game.dungeon.tiles.map((row, y) => [...row].map((c, x) => {
    if (x === game.pos[0] && y === game.pos[1]) return '@';
    const a = game.adversaries.find((v) => v.pos[0] === x && v.pos[1] === y);
    if (a) return a.mode === 'chase' ? 'C' : 'A';
    if (x === game.dungeon.treasure[0] && y === game.dungeon.treasure[1]) return 'T';
    if (reveal || game.isKnown([x, y])) return c;
    return c === '#' ? ' ' : ',';
  }).join('')).join('\n');
  console.log(`\nseed ${small} (${d.width}x${d.height}), full map (@ explorer, T chest, A adversary):`);
  console.log(render(g, true));

  // Walk toward the chest's side, then put a chaser in sight and show what Jev would get.
  for (let i = 0; i < 12; i++) {
    const t = approachTarget(new KnownWorld(g), 'far_side');
    const dir = t && knownStepTowards(g, t.cell);
    if (dir) g.applyMove(dir);
  }
  const near = [];
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    const c = [g.pos[0] + dx, g.pos[1] + dy];
    if ((dx || dy) && d.tiles[c[1]]?.[c[0]] === '.' && sees(d, g.pos, c) && euclid(g.pos, c) >= 3) near.push(c);
  }
  g.adversaries = [new Adversary({ id: 'a1', pos: near[0] ?? g.pos, mode: 'chase' }),
    new Adversary({ id: 'a2', pos: near.at(-1) ?? g.pos })];
  console.log(`\nafter ${g.steps} steps with a chaser (C) and a patroller (A) in sight; blank/"," = unknown wall/floor:`);
  console.log(render(g, false));
  console.log('\nsituation:', JSON.stringify(situation(new KnownWorld(g)), null, 2));
  console.log('availableApproaches:', availableApproaches(new KnownWorld(g)).join(', '));
  console.log('approachTarget(run_away):', JSON.stringify(approachTarget(new KnownWorld(g), 'run_away')));
  console.log('describeMoves(run_away):', JSON.stringify(describeMoves(new KnownWorld(g), 'run_away'), null, 2));
  for (const id of ['wary', 'greedy', 'bold']) {
    console.log(`tacticOptions (${id}, min gap ${SENTIMENTS[id].min_gap}):`, JSON.stringify(tacticOptions(new KnownWorld(g), SENTIMENTS[id].min_gap), null, 2));
  }
}

// Health: 2 lives, lost only when all are gone.
{
  const g = new Game(generateDungeon(3));
  if (!(g.health === EXPLORER_LIVES && g.maxHealth === 2)) fail('health: starts at 2/2');
  const pv = g.publicView();
  if (!(pv.health === 2 && pv.max_health === 2)) fail('health: publicView includes health and max_health');
  const r1 = g.damage(1, 'a1');
  if (!(r1.health === 1 && !r1.lost && !g.lost && g.caughtBy === null)) fail('health: first hit leaves 1 life');
  if (!(g.publicView().health === 1)) fail('health: publicView follows damage');
  const r2 = g.damage(1, 'a2');
  if (!(r2.health === 0 && r2.lost && g.lost && g.caughtBy === 'a2')) fail('health: second hit loses the game');
  const r3 = g.damage(1, 'a3');
  if (!(r3.health === 0 && g.caughtBy === 'a2')) fail('health: no-op once lost');
  const g2 = new Game(generateDungeon(3));
  g2.won = true;
  if (!(g2.damage(1, 'a1').health === 2 && !g2.lost)) fail('health: no-op once won');
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
