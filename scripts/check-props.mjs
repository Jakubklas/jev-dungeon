// Placement checks for props and wall decor (CONTRACT.md, v4), over a few hundred seeds.
// Run from the dungeon-game directory: node scripts/check-props.mjs [seeds]

import { generateDungeon, Game, hasLineOfSight, MIN_SIZE, MAX_SIZE, SIGHT_RANGE } from '../src/dungeon.js';
import { KINDS, SOLID_KINDS, SMALL_KINDS, BIG_DECOR_KINDS, TORCH_MAX, BIG_MIN_RUN, CLUSTER_SIZE_MIN, CLUSTER_SIZE_MAX, CLUSTER_MAX, SMALL_MAX, TREASURE_FRACTION } from '../src/props/catalog.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SEEDS = Number(process.argv[2]) || 300;
const COVER_SEEDS = SEEDS; // full pairwise cover stats (fast enough for every seed)
let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures <= 20) console.error('FAIL:', msg);
};

// Reference generator without props: dungeon.js with the placeProps call stubbed out.
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'props-check-'));
const stubbed = readFileSync(join(srcDir, 'dungeon.js'), 'utf8')
  .replace(/import \{ placeProps \} from '\.\/props\/place\.js';/, 'const placeProps = (d) => ({ tiles: d.tiles, props: [], decor: [] });');
if (!stubbed.includes('const placeProps =')) { console.error('cannot stub placeProps in dungeon.js'); process.exit(1); }
writeFileSync(join(tmp, 'dungeon-bare.mjs'), stubbed);
const { generateDungeon: generateBare } = await import(pathToFileURL(join(tmp, 'dungeon-bare.mjs')).href);
rmSync(tmp, { recursive: true, force: true });

const NB = [[0, -1], [0, 1], [-1, 0], [1, 0]];
const kindCount = Object.fromEntries(Object.keys(KINDS).map((k) => [k, 0]));
let totalProps = 0, totalDecor = 0, totalMs = 0, maps = 0, small = 0, large = 0, corridorTorches = 0, corridorSmall = 0;
let minW = Infinity, maxW = 0;
const sizeHist = Object.fromEntries(Array.from({ length: CLUSTER_SIZE_MAX }, (_, i) => [i + 1, 0]));
let clusters = 0, clusterRooms = 0, roomsTotal = 0;
let coverPairs = 0, coverBlocked = 0, coverCells = 0, coverHidden = 0, coverRooms = 0;

for (let seed = 1; seed <= SEEDS; seed++) {
  const t0 = performance.now();
  const d = generateDungeon(seed);
  totalMs += performance.now() - t0;
  maps++;
  const { width: W, height: H, rooms, start, treasure } = d;
  const props = d.props, decor = d.decor;
  const id = `seed ${seed}`;
  minW = Math.min(minW, W, H); maxW = Math.max(maxW, W, H);
  if (Math.max(W, H) >= MAX_SIZE - 15) large++;
  if (Math.min(W, H) <= MIN_SIZE + 10) small++;
  if (!Array.isArray(props) || !Array.isArray(decor)) { fail(`${id}: props/decor missing`); continue; }
  totalProps += props.length; totalDecor += decor.length;

  // Determinism and untouched layout.
  if (JSON.stringify(generateDungeon(seed)) !== JSON.stringify(d)) fail(`${id}: not deterministic`);
  const bare = generateBare(seed);
  const solids = props.filter((p) => p.solid);
  const restored = d.tiles.map((r) => r.split(''));
  for (const p of solids) restored[p.y][p.x] = '.';
  if (restored.map((r) => r.join('')).join('\n') !== bare.tiles.join('\n')) fail(`${id}: layout differs from a no-props generation`);
  if (JSON.stringify([d.start, d.treasure, d.rooms, d.width, d.height]) !== JSON.stringify([bare.start, bare.treasure, bare.rooms, bare.width, bare.height])) fail(`${id}: start/treasure/rooms differ from a no-props generation`);
  const pv = new Game(d).publicView();
  if (pv.props !== d.props || pv.decor !== d.decor) fail(`${id}: publicView does not pass props/decor through`);

  const base = bare.tiles; // original layout
  const floor0 = (x, y) => base[y]?.[x] === '.';
  const roomIdx = (x, y) => rooms.findIndex((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  const isFloor = (x, y) => d.tiles[y]?.[x] === '.';
  const key = (x, y) => y * W + x;
  const propAt = new Map(props.map((p) => [key(p.x, p.y), p]));

  // Sorting, shape, kinds.
  const sorted = (a) => a.every((p, i) => i === 0 || a[i - 1].y < p.y || (a[i - 1].y === p.y && a[i - 1].x < p.x));
  if (!sorted(props)) fail(`${id}: props not sorted by y then x (or duplicate cell)`);
  if (!sorted(decor)) fail(`${id}: decor not sorted by y then x (or duplicate cell)`);
  for (const p of props) {
    const k = KINDS[p.kind];
    if (!k || k.cls === 'decor') fail(`${id}: bad prop kind ${p.kind}`);
    else {
      kindCount[p.kind]++;
      if (p.solid !== k.solid || typeof p.flip !== 'boolean') fail(`${id}: prop ${p.kind}@${p.x},${p.y} has wrong solid/flip`);
    }
    if (!floor0(p.x, p.y)) fail(`${id}: prop ${p.kind}@${p.x},${p.y} not on original floor`);
    if (p.solid !== (d.tiles[p.y][p.x] === '#')) fail(`${id}: prop ${p.kind}@${p.x},${p.y} solid flag disagrees with tiles`);
  }
  for (const c of decor) {
    if (KINDS[c.kind]?.cls !== 'decor') fail(`${id}: bad decor kind ${c.kind}`);
    else kindCount[c.kind]++;
    if (c.face !== 'L' && c.face !== 'R') fail(`${id}: decor ${c.kind}@${c.x},${c.y} bad face ${c.face}`);
  }

  // Decor.
  const decorAt = new Map(decor.map((c) => [key(c.x, c.y), c]));
  const frontOf = (c) => (c.face === 'L' ? [c.x, c.y + 1] : [c.x + 1, c.y]);
  const frontSet = new Set(decor.map((c) => key(...frontOf(c))));
  const bigPerRoom = new Map(), torchPerRoom = new Map();
  for (const c of decor) {
    if (floor0(c.x, c.y) || propAt.has(key(c.x, c.y))) fail(`${id}: decor ${c.kind}@${c.x},${c.y} not on a wall cell`);
    const [fx, fy] = frontOf(c);
    if (!isFloor(fx, fy)) fail(`${id}: decor ${c.kind}@${c.x},${c.y} face ${c.face} does not touch open floor`);
    for (const [dx, dy] of NB) if (decorAt.has(key(c.x + dx, c.y + dy))) fail(`${id}: decor ${c.x},${c.y} 4-adjacent to another decor`);
    const ri = roomIdx(fx, fy);
    if (c.kind === 'torch') {
      if (ri >= 0) torchPerRoom.set(ri, (torchPerRoom.get(ri) ?? 0) + 1);
      else corridorTorches++;
    } else if (BIG_DECOR_KINDS.includes(c.kind)) {
      if (ri < 0) { fail(`${id}: ${c.kind}@${c.x},${c.y} not facing a room`); continue; }
      bigPerRoom.set(ri, (bigPerRoom.get(ri) ?? 0) + 1);
      const r = rooms[ri];
      const along = c.face === 'L' ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]];
      if ((c.face === 'L' ? r.w : r.h) < BIG_MIN_RUN) fail(`${id}: ${c.kind}@${c.x},${c.y} room too short along the wall`);
      for (const [dx, dy] of along) {
        const [nx, ny] = [c.x + dx, c.y + dy], [mx, my] = frontOf({ ...c, x: nx, y: ny });
        if (floor0(nx, ny) || !floor0(mx, my) || roomIdx(mx, my) !== ri) fail(`${id}: ${c.kind}@${c.x},${c.y} not on a straight wall run`);
      }
    }
  }
  for (const [ri, n] of bigPerRoom) if (n > 1) fail(`${id}: room ${ri} has ${n} fireplace/arch/gate`);
  rooms.forEach((r, ri) => {
    const n = torchPerRoom.get(ri) ?? 0;
    if (n < 1 || n > TORCH_MAX) fail(`${id}: room ${ri} has ${n} torches`);
  });

  // Doorways: room floor cells touching floor outside their room rect.
  const doorway = (x, y) => {
    const ri = roomIdx(x, y);
    return ri >= 0 && floor0(x, y) && NB.some(([dx, dy]) => floor0(x + dx, y + dy) && roomIdx(x + dx, y + dy) !== ri);
  };

  // Solid props: free-standing clusters inside rooms, off the room's edge ring.
  const perRoomCluster = new Map(), perRoomSmall = new Map();
  for (const p of solids) {
    const { x, y } = p;
    const ri = roomIdx(x, y);
    if (ri < 0) { fail(`${id}: solid ${p.kind}@${x},${y} not inside a room`); continue; }
    const r = rooms[ri];
    if (x <= r.x || x >= r.x + r.w - 1 || y <= r.y || y >= r.y + r.h - 1) fail(`${id}: solid ${p.kind}@${x},${y} on the room's edge ring (no lane behind it)`);
    if (doorway(x, y) || NB.some(([dx, dy]) => doorway(x + dx, y + dy))) fail(`${id}: solid ${p.kind}@${x},${y} on/next to a doorway`);
    for (const c of [start, treasure]) if (Math.abs(x - c[0]) <= 1 && Math.abs(y - c[1]) <= 1) fail(`${id}: solid ${p.kind}@${x},${y} on/next to start or treasure`);
    if (frontSet.has(key(x, y))) fail(`${id}: solid ${p.kind}@${x},${y} in front of decor`);
    for (const [dx, dy] of NB) {
      if (!isFloor(x + dx, y + dy)) continue;
      const exits = NB.filter(([ex, ey]) => isFloor(x + dx + ex, y + dy + ey)).length;
      if (exits < 2) fail(`${id}: solid ${p.kind}@${x},${y} leaves a dead end at ${x + dx},${y + dy}`);
    }
  }
  // Clusters = 4-connected components of solid cells; different clusters may not touch, diagonals included.
  const comp = new Map();
  const comps = [];
  for (const p of solids) {
    if (comp.has(key(p.x, p.y))) continue;
    const cells = [[p.x, p.y]];
    comp.set(key(p.x, p.y), comps.length);
    for (let i = 0; i < cells.length; i++) {
      for (const [dx, dy] of NB) {
        const nx = cells[i][0] + dx, ny = cells[i][1] + dy, q = propAt.get(key(nx, ny));
        if (q?.solid && !comp.has(key(nx, ny))) { comp.set(key(nx, ny), comps.length); cells.push([nx, ny]); }
      }
    }
    comps.push(cells);
  }
  for (const [ci, cells] of comps.entries()) {
    const n = cells.length, [cx, cy] = cells[0], ri = roomIdx(cx, cy);
    clusters++;
    if (n < CLUSTER_SIZE_MIN || n > CLUSTER_SIZE_MAX) fail(`${id}: cluster at ${cx},${cy} has ${n} cells`);
    else sizeHist[n]++;
    if (cells.some(([x, y]) => roomIdx(x, y) !== ri)) fail(`${id}: cluster at ${cx},${cy} spans rooms`);
    for (const [x, y] of cells) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const o = comp.get(key(x + dx, y + dy));
        if (o !== undefined && o !== ci) fail(`${id}: clusters at ${cx},${cy} and ${x + dx},${y + dy} touch`);
      }
    }
    if (ri >= 0) perRoomCluster.set(ri, (perRoomCluster.get(ri) ?? 0) + 1);
    // Cover: with only this cluster added to the bare room, some pair of room cells in sight range loses LOS.
    if (ri < 0) continue;
    const r = rooms[ri];
    const own = new Set(cells.map(([x, y]) => key(x, y)));
    const only = { width: W, height: H, tiles: base.map((row, y) => (y < r.y || y >= r.y + r.h ? row
      : row.split('').map((ch, x) => (own.has(key(x, y)) ? '#' : ch)).join(''))) };
    const roomCells = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (!own.has(key(x, y))) roomCells.push([x, y]);
    let casts = false;
    for (let i = 0; i < roomCells.length && !casts; i++) {
      for (let j = i + 1; j < roomCells.length && !casts; j++) {
        const [a, b] = [roomCells[i], roomCells[j]];
        // Diagonal neighbours don't count: the corner rule lets even a corner-jammed prop block those.
        const cheb = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
        if (cheb >= 2 && Math.hypot(a[0] - b[0], a[1] - b[1]) <= SIGHT_RANGE && !hasLineOfSight(only, a, b)) casts = true;
      }
    }
    if (!casts) fail(`${id}: cluster at ${cx},${cy} hides nothing`);
  }
  for (const [ri, n] of perRoomCluster) if (n > CLUSTER_MAX) fail(`${id}: room ${ri} has ${n} clusters`);
  roomsTotal += rooms.length;
  clusterRooms += perRoomCluster.size;
  // No split rooms: each room's floor connects inside its own rect.
  rooms.forEach((r, ri) => {
    const inR = (x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    const cells = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (isFloor(x, y)) cells.push([x, y]);
    if (!cells.length) return;
    const seen = new Set([key(...cells[0])]);
    const q = [cells[0]];
    for (let i = 0; i < q.length; i++) {
      for (const [dx, dy] of NB) {
        const nx = q[i][0] + dx, ny = q[i][1] + dy;
        if (inR(nx, ny) && isFloor(nx, ny) && !seen.has(key(nx, ny))) { seen.add(key(nx, ny)); q.push([nx, ny]); }
      }
    }
    if (seen.size !== cells.length) fail(`${id}: room ${ri} split (${seen.size}/${cells.length})`);
  });
  // Cover stats: in-room pairs in sight range that clusters block (bare rooms are convex, so all
  // would see each other), and hiding cells: hidden from at least a quarter of the room in range.
  if (seed <= COVER_SEEDS) {
    for (const ri of perRoomCluster.keys()) {
      const r = rooms[ri];
      const cells = [];
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (isFloor(x, y)) cells.push([x, y]);
      const inRange = new Array(cells.length).fill(0), hidden = new Array(cells.length).fill(0);
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const [a, b] = [cells[i], cells[j]];
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) > SIGHT_RANGE) continue;
          inRange[i]++; inRange[j]++; coverPairs++;
          if (!hasLineOfSight(d, a, b)) { hidden[i]++; hidden[j]++; coverBlocked++; }
        }
      }
      coverRooms++;
      coverCells += cells.length;
      for (let i = 0; i < cells.length; i++) if (inRange[i] && hidden[i] >= inRange[i] / 4) coverHidden++;
    }
  }

  // Connectivity and treasure distance over the final floor.
  const dist = new Map([[key(...start), 0]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of NB) {
      if (isFloor(x + dx, y + dy) && !dist.has(key(x + dx, y + dy))) { dist.set(key(x + dx, y + dy), dist.get(key(x, y)) + 1); queue.push([x + dx, y + dy]); }
    }
  }
  let floor = 0, far = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isFloor(x, y)) floor++;
  for (const v of dist.values()) far = Math.max(far, v);
  if (dist.size !== floor) fail(`${id}: floor split into regions (${dist.size}/${floor})`);
  const td = dist.get(key(...treasure));
  if (td === undefined || td < TREASURE_FRACTION * far) fail(`${id}: treasure too close (${td} < ${TREASURE_FRACTION} * ${far})`);
  if (!isFloor(...start) || !isFloor(...treasure)) fail(`${id}: start or treasure not floor`);

  // Small props.
  for (const p of props.filter((q) => !q.solid)) {
    const { x, y } = p;
    if (!isFloor(x, y)) fail(`${id}: small ${p.kind}@${x},${y} not on open floor`);
    if ((x === start[0] && y === start[1]) || Math.abs(x - treasure[0]) + Math.abs(y - treasure[1]) <= 1) fail(`${id}: small ${p.kind}@${x},${y} on start or on/next to treasure`);
    const ri = roomIdx(x, y);
    if (ri < 0) corridorSmall++;
    else perRoomSmall.set(ri, (perRoomSmall.get(ri) ?? 0) + 1);
  }
  for (const [ri, n] of perRoomSmall) if (n > SMALL_MAX) fail(`${id}: room ${ri} has ${n} small props`);
}

for (let n = CLUSTER_SIZE_MIN; n <= CLUSTER_SIZE_MAX; n++) if (!sizeHist[n]) fail(`no cluster of size ${n} in ${SEEDS} seeds`);
const MIN_PAIRS_BLOCKED = 0.1, MIN_CELLS_HIDDEN = 0.15; // floors well under the measured ~19% / ~29%
if (coverBlocked < MIN_PAIRS_BLOCKED * coverPairs) fail(`clusters block only ${coverBlocked}/${coverPairs} in-room pairs`);
if (coverHidden < MIN_CELLS_HIDDEN * coverCells) fail(`only ${coverHidden}/${coverCells} floor cells in cluster rooms are hiding spots`);
for (const k of [...SOLID_KINDS, ...SMALL_KINDS, 'torch', ...BIG_DECOR_KINDS]) {
  if (!kindCount[k]) fail(`kind ${k} never appears in ${SEEDS} seeds`);
}

console.log(`${maps} maps (${small} with a side <= ${MIN_SIZE + 10}, ${large} with a side >= ${MAX_SIZE - 15}; sides ${minW}..${maxW})`);
console.log(`avg per map: ${(totalProps / maps).toFixed(1)} props (${corridorSmall} small in corridors overall), ${(totalDecor / maps).toFixed(1)} decor (${corridorTorches} corridor torches overall)`);
console.log('per kind:', JSON.stringify(kindCount));
console.log(`clusters: ${clusters} in ${clusterRooms}/${roomsTotal} rooms (${(clusters / maps).toFixed(1)}/map), sizes 1..${CLUSTER_SIZE_MAX}: ${JSON.stringify(sizeHist)}`);
console.log(`cover (${COVER_SEEDS} seeds, ${coverRooms} rooms with clusters): ${(100 * coverBlocked / coverPairs).toFixed(1)}% of in-room pairs in sight range blocked; ` +
  `${(100 * coverHidden / coverCells).toFixed(1)}% of their floor cells hidden from >= 1/4 of the room in range`);
console.log(`generation (with props, plus determinism and bare re-runs not timed): ${(totalMs / maps).toFixed(1)} ms/map`);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
