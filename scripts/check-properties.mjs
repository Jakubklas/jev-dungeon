// Property-based checks (fast-check): invariants of dungeon generation, line of sight and testbed
// arenas over generated seeds and configs instead of hand-picked ones. A failure prints the
// shrunk counterexample (the smallest seed / config that still fails) and its replay seed.
// Run from the dungeon-game directory: node scripts/check-properties.mjs [--runs N] [--seed S]
// Free, no Jev.

// Tripwire: nothing here should touch the network, let alone the paid Jev API.
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import fc from 'fast-check';
import { generateDungeon, hasLineOfSight, floorDistances, isFloor, rng, configureWorld, MIN_SIZE, MAX_SIZE, ROOM_MIN, ROOM_MAX, LAYOUT } from '../src/dungeon.js';
import { buildArena, TestbedError, TESTBED_MIN, TESTBED_MAX, TESTBED_MAX_ADVERSARIES } from '../src/testbed.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : undefined;
};
const RUNS = arg('runs') ?? 200;
const SEED = arg('seed');

let failures = 0;
// Runs one property; fast-check throws with the shrunk counterexample and the replay seed.
function property(name, prop, runs = RUNS) {
  const t = Date.now();
  try {
    fc.assert(prop, { numRuns: runs, ...(SEED !== undefined && { seed: SEED }) });
    console.log(`ok   ${name} (${runs} runs, ${Date.now() - t} ms)`);
  } catch (err) {
    failures++;
    console.error(`FAIL: ${name}\n${err.message}`);
  }
}

const seedArb = fc.integer({ min: 0, max: 2 ** 32 - 1 });
const floorCells = (d) => {
  const out = [];
  for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) if (d.tiles[y][x] === '.') out.push([x, y]);
  return out;
};
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

// --- rng ---------------------------------------------------------------------------------------

property('rng: same seed, same stream; every value in [0, 1)', fc.property(seedArb, (seed) => {
  const a = rng(seed), b = rng(seed);
  for (let i = 0; i < 50; i++) {
    const v = a();
    if (v !== b() || !(v >= 0 && v < 1)) return false;
  }
  return true;
}), 500);

// --- dungeon generation ------------------------------------------------------------------------

property('dungeon: a seed always rebuilds the same dungeon', fc.property(seedArb, (seed) =>
  JSON.stringify(generateDungeon(seed)) === JSON.stringify(generateDungeon(seed))));

property('dungeon: size in range, outer ring is wall, only # and . tiles', fc.property(seedArb, (seed) => {
  const d = generateDungeon(seed);
  if (d.width < MIN_SIZE || d.width > MAX_SIZE || d.height < MIN_SIZE || d.height > MAX_SIZE) return false;
  if (d.tiles.length !== d.height || d.tiles.some((row) => row.length !== d.width || /[^#.]/.test(row))) return false;
  for (let x = 0; x < d.width; x++) if (d.tiles[0][x] !== '#' || d.tiles[d.height - 1][x] !== '#') return false;
  for (let y = 0; y < d.height; y++) if (d.tiles[y][0] !== '#' || d.tiles[y][d.width - 1] !== '#') return false;
  return true;
}));

property('dungeon: start and chest are distinct floor cells, and every floor cell is reachable from start', fc.property(seedArb, (seed) => {
  const d = generateDungeon(seed);
  if (!isFloor(d, d.start) || !isFloor(d, d.treasure) || same(d.start, d.treasure)) return false;
  const dist = floorDistances(d, d.start);
  return dist.size === floorCells(d).length && dist.has(`${d.treasure[0]},${d.treasure[1]}`);
}));

// --- linear layout (LAYOUT 'linear'; scripts/check-layout.mjs checks it in depth) ----------------

// Any seed, any map-size and room-size knobs: a valid linear dungeon whose path rooms cannot be skipped.
const WORLD = { layout: LAYOUT, minSize: MIN_SIZE, maxSize: MAX_SIZE, roomMin: ROOM_MIN, roomMax: ROOM_MAX }; // restored after each run (live bindings)
const linearArb = fc.record({
  seed: seedArb,
  lo: fc.integer({ min: 25, max: 90 }), hi: fc.integer({ min: 25, max: 90 }),
  roomMin: fc.integer({ min: 2, max: 10 }), roomMax: fc.integer({ min: 4, max: 30 }),
});
property('linear: walled, all floor reachable, portal clear, every path room on the only way (bar one loop)', fc.property(linearArb, ({ seed, lo, hi, roomMin, roomMax }) => {
  configureWorld({ layout: 'linear', minSize: Math.min(lo, hi), maxSize: Math.max(lo, hi), roomMin, roomMax });
  try {
    const d = generateDungeon(seed);
    if (JSON.stringify(d) !== JSON.stringify(generateDungeon(seed))) return false;
    const { width: W, height: H, tiles, start, treasure, rooms, layout } = d;
    for (let x = 0; x < W; x++) if (tiles[0][x] !== '#' || tiles[H - 1][x] !== '#') return false;
    for (let y = 0; y < H; y++) if (tiles[y][0] !== '#' || tiles[y][W - 1] !== '#') return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (tiles[treasure[1] + dy][treasure[0] + dx] !== '.') return false;
    if (floorDistances(d, start).size !== floorCells(d).length) return false;
    const n = rooms.filter((r) => r.role !== 'side').length;
    const inP = (p, [x, y]) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
    const loopEnds = rooms.map((_, j) => layout.links.filter(([a, b]) => b === j && a < j).map(([a]) => a)).filter((e) => e.length === 2);
    const bypassed = new Set(loopEnds.map((e) => Math.min(...e) + 1));
    for (let r = 1; r < n - 1; r++) {
      if (bypassed.has(r)) continue;
      const closed = { ...d, tiles: tiles.map((row, y) => [...row].map((c, x) => (inP(layout.patches[r], [x, y]) ? '#' : c)).join('')) };
      if (floorDistances(closed, start).has(`${treasure[0]},${treasure[1]}`)) return false;
    }
    return true;
  } finally {
    configureWorld(WORLD);
  }
}), 100);

// --- line of sight -----------------------------------------------------------------------------

// A dungeon plus two floor cells in it, drawn by index so fast-check can shrink them.
const sightArb = seedArb.chain((seed) => {
  const d = generateDungeon(seed);
  const n = floorCells(d).length;
  return fc.tuple(fc.constant(seed), fc.nat(n - 1), fc.nat(n - 1));
});

property('LOS: symmetric, and always true between a cell and its neighbours', fc.property(sightArb, ([seed, i, j]) => {
  const d = generateDungeon(seed);
  const cells = floorCells(d);
  const a = cells[i], b = cells[j];
  if (hasLineOfSight(d, a, b) !== hasLineOfSight(d, b, a)) return false;
  if (!hasLineOfSight(d, a, a)) return false;
  for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
    const n = [a[0] + dx, a[1] + dy];
    if (isFloor(d, n) && !hasLineOfSight(d, a, n)) return false;
  }
  return true;
}), 300);

// --- testbed arenas ----------------------------------------------------------------------------

const sideArb = fc.integer({ min: TESTBED_MIN, max: 25 });
const configArb = fc.record({
  seed: seedArb,
  size: fc.tuple(sideArb, sideArb),
  numAdversaries: fc.integer({ min: 0, max: TESTBED_MAX_ADVERSARIES }),
  props: fc.constantFrom('none', 'few', 'many'),
  treasure: fc.constantFrom(null, 'far'),
  coins: fc.integer({ min: 0, max: 10 }),
}, { requiredKeys: ['seed', 'size'] });

// A config may be rejected (a TestbedError with a readable reason), but must never crash otherwise.
const tryArena = (cfg) => {
  try {
    return buildArena(cfg);
  } catch (err) {
    if (err instanceof TestbedError) return null;
    throw err;
  }
};

property('testbed: an arena is a pure function of its config', fc.property(configArb, (cfg) =>
  JSON.stringify(tryArena(cfg)) === JSON.stringify(tryArena(cfg))), 200);

property('testbed: start on floor; ghosts on distinct floor cells, none on start', fc.property(configArb, (cfg) => {
  const arena = tryArena(cfg);
  if (!arena) return true;
  const { dungeon: d, adversaries } = arena;
  if (!isFloor(d, d.start)) return false;
  const seen = new Set();
  for (const { pos } of adversaries) {
    const k = `${pos[0]},${pos[1]}`;
    if (!isFloor(d, pos) || same(pos, d.start) || seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}), 200);

// Garbage in: any JSON-ish value for any known option must give an arena or a TestbedError.
const fuzzArb = fc.dictionary(
  fc.constantFrom('seed', 'size', 'start', 'treasure', 'numAdversaries', 'adversaries', 'minAdversaryGap',
    'adversariesInSight', 'kinds', 'props', 'map', 'explorerSkills', 'ghostSkills', 'ghostHp', 'coins', 'hearts'),
  fc.oneof(fc.jsonValue({ maxDepth: 2 }), fc.string({ maxLength: 12 }), fc.integer({ min: -5, max: TESTBED_MAX + 5 })),
  { maxKeys: 4 },
);

property('testbed: malformed configs are rejected with a TestbedError, never a crash', fc.property(fuzzArb, (raw) => {
  tryArena(raw);
  return true;
}), 500);

if (failures) {
  console.error(`\n${failures} propert${failures === 1 ? 'y' : 'ies'} failed. Replay with --seed <seed> from the report.`);
  process.exit(1);
}
console.log('\nall properties hold');
