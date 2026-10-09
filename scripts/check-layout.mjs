// Checks for the linear layout (LAYOUT 'linear' in src/dungeon.js): one winding path of rooms from the start to
// the portal, dead-end side rooms and at most one loop that bypasses a single room. Read from the finished tiles,
// over 200 seeds plus the size extremes: determinism, wall ring, reachability, room roles and order, the path
// cannot be skipped, side rooms are dead ends, the portal has its 3x3 clear, and corridors vary in width.
// Run from the dungeon-game directory: node scripts/check-layout.mjs [seeds] [--quiet]. Free, no Jev.

process.env.JEV_CONFIG = 'none';
globalThis.fetch = () => { throw new Error('network call in a check script'); };

const world = await import('../src/dungeon.js'); // namespace: MIN_SIZE / MAX_SIZE are live bindings that configureWorld changes
const { generateDungeon, configureWorld } = world;

const SEEDS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 200;
const QUIET = process.argv.includes('--quiet');
let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures <= 25) console.error('FAIL:', msg);
};

const inRect = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

// 4-way BFS over floor, skipping cells for which `closed(x, y)` is true. Returns a Uint8Array of reached cells.
function reach(d, from, closed = () => false) {
  const { width: W, height: H, tiles } = d;
  const seen = new Uint8Array(W * H);
  if (tiles[from[1]][from[0]] !== '.' || closed(from[0], from[1])) return seen;
  const queue = [from[1] * W + from[0]];
  seen[queue[0]] = 1;
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h], x = i % W, y = (i / W) | 0;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || tiles[ny][nx] !== '.' || closed(nx, ny)) continue;
      const j = ny * W + nx;
      if (!seen[j]) { seen[j] = 1; queue.push(j); }
    }
  }
  return seen;
}

// Every invariant of one linear dungeon. Returns a list of problems (empty = fine) and a few numbers for the stats.
function verifyLinear(d) {
  const errs = [];
  const { width: W, height: H, tiles, rooms, layout, start, treasure } = d;
  if (!layout || layout.kind !== 'linear') return { errs: ['no linear layout'] };
  const { patches, links } = layout;
  for (let x = 0; x < W; x++) if (tiles[0][x] !== '#' || tiles[H - 1][x] !== '#') errs.push('outer ring not wall');
  for (let y = 0; y < H; y++) if (tiles[y][0] !== '#' || tiles[y][W - 1] !== '#') errs.push('outer ring not wall');
  if (patches.length !== rooms.length) errs.push('patches and rooms differ in count');

  // Roles and order: path rooms first (start 0 .. portal n-1), then side rooms hanging off a non-portal path room.
  const n = rooms.findIndex((r) => r.role === 'side') < 0 ? rooms.length : rooms.findIndex((r) => r.role === 'side');
  rooms.forEach((r, i) => {
    const want = i === 0 ? 'start' : i === n - 1 ? 'portal' : i < n ? 'path' : 'side';
    if (r.role !== want) errs.push(`room ${i} role ${r.role}, want ${want}`);
    if (i < n && r.order !== i) errs.push(`path room ${i} has order ${r.order}`);
    if (i >= n && !(r.order >= 0 && r.order < n - 1)) errs.push(`side room ${i} hangs off ${r.order}`);
    const p = patches[i];
    if (!(inRect(p, r.x, r.y) && inRect(p, r.x + r.w - 1, r.y + r.h - 1))) errs.push(`room ${i} box leaves its patch`);
  });
  if (n < 3) errs.push(`path of ${n} rooms`);
  for (let i = 1; i < n; i++) if (!links.some(([a, b]) => a === i - 1 && b === i)) errs.push(`path rooms ${i - 1}-${i} not linked`);

  // Patches are 2 wall cells apart, and floor outside every patch lies in the strip between two linked patches.
  for (let i = 0; i < patches.length; i++) {
    for (let j = i + 1; j < patches.length; j++) {
      const a = patches[i], b = patches[j];
      const gx = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w), gy = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
      if (Math.max(gx, gy) < 2) errs.push(`patches ${i} and ${j} closer than 2 cells`);
    }
  }
  const owner = (x, y) => patches.findIndex((p) => inRect(p, x, y));
  let stripWide = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (tiles[y][x] !== '.' || owner(x, y) >= 0) continue;
      const ok = links.some(([a, b]) => {
        const pa = patches[a], pb = patches[b];
        const R = { x: Math.min(pa.x, pb.x), y: Math.min(pa.y, pb.y) };
        R.w = Math.max(pa.x + pa.w, pb.x + pb.w) - R.x; R.h = Math.max(pa.y + pa.h, pb.y + pb.h) - R.y;
        return inRect(R, x, y);
      });
      if (!ok) errs.push(`floor ${x},${y} outside every patch and strip`);
      if (owner(x + 1, y) < 0 && owner(x, y + 1) < 0 && tiles[y][x + 1] === '.' && tiles[y + 1]?.[x] === '.') stripWide = true;
    }
  }

  // Reachability, start and portal.
  if (tiles[start[1]][start[0]] !== '.' || !inRect(patches[0], ...start)) errs.push('start not on floor in room 0');
  if (!inRect(patches[n - 1], ...treasure)) errs.push('portal not in the portal room');
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (tiles[treasure[1] + dy][treasure[0] + dx] !== '.') errs.push('portal 3x3 not clear');
  const all = reach(d, start);
  let floor = 0, reached = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tiles[y][x] === '.') { floor++; reached += all[y * W + x]; }
  if (reached !== floor) errs.push(`${floor - reached} floor cells unreachable`);
  if (!all[treasure[1] * W + treasure[0]]) errs.push('portal unreachable');

  // The path cannot be skipped: closing a path room's patch cuts the start off from the portal, unless a loop bypasses it.
  const linksOf = (j) => links.filter(([a, b]) => a === j || b === j).map(([a, b]) => (a === j ? b : a));
  const bypassed = new Set();
  let loops = 0;
  for (let j = n; j < rooms.length; j++) {
    const ends = linksOf(j).filter((k) => k < j); // its parents: a deeper side room links to its child too
    if (ends.length === 2) {
      loops++;
      const [a, b] = ends.sort((p, q) => p - q);
      if (!(a < n && b < n && b - a === 2)) errs.push(`loop room ${j} links ${a} and ${b}`);
      bypassed.add(a + 1);
    } else if (ends.length !== 1) errs.push(`side room ${j} has ${ends.length} links`);
  }
  if (loops > 1) errs.push(`${loops} loops`);
  for (let r = 1; r < n - 1; r++) {
    if (bypassed.has(r)) continue;
    if (reach(d, start, (x, y) => inRect(patches[r], x, y))[treasure[1] * W + treasure[0]]) errs.push(`path room ${r} can be skipped`);
  }
  // Side rooms are dead ends: with the one room they hang off closed, nothing of theirs is reachable from the portal.
  for (let j = n; j < rooms.length; j++) {
    const ends = linksOf(j).filter((k) => k < j);
    if (ends.length !== 1) continue;
    const seen = reach(d, treasure, (x, y) => inRect(patches[ends[0]], x, y));
    const p = patches[j];
    let leak = false;
    for (let y = p.y; y < p.y + p.h && !leak; y++) for (let x = p.x; x < p.x + p.w; x++) if (seen[y * W + x]) { leak = true; break; }
    if (leak) errs.push(`side room ${j} is not a dead end`);
  }
  // Path length start -> portal.
  let dist = 0;
  {
    const D = new Int32Array(W * H).fill(-1), q = [start[1] * W + start[0]];
    D[q[0]] = 0;
    for (let h = 0; h < q.length; h++) {
      const i = q[h], x = i % W, y = (i / W) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        const j = ny * W + nx;
        if (tiles[ny][nx] === '.' && D[j] < 0) { D[j] = D[i] + 1; q.push(j); }
      }
    }
    dist = D[treasure[1] * W + treasure[0]];
  }
  return { errs, n, sides: rooms.length - n, loops, stripWide, dist };
}

function ascii(d) {
  const g = d.tiles.map((r) => r.split('').map((c) => (c === '#' ? ' ' : '·')));
  for (const p of d.props ?? []) if (p.solid) g[p.y][p.x] = 'o';
  g[d.start[1]][d.start[0]] = 'S';
  g[d.treasure[1]][d.treasure[0]] = 'P';
  return g.map((r) => r.join('').trimEnd()).join('\n');
}

const stats = { maps: 0, ms: 0, maxMs: 0, rooms: 0, sides: 0, loops: 0, wide: 0, dist: 0, minDist: Infinity };
function run(label, seeds) {
  for (const seed of seeds) {
    const t = performance.now();
    const d = generateDungeon(seed);
    const ms = performance.now() - t;
    stats.maps++; stats.ms += ms; stats.maxMs = Math.max(stats.maxMs, ms);
    if (JSON.stringify(generateDungeon(seed)) !== JSON.stringify(d)) fail(`${label} seed ${seed}: not deterministic`);
    if (d.width < world.MIN_SIZE || d.width > world.MAX_SIZE || d.height < world.MIN_SIZE || d.height > world.MAX_SIZE) fail(`${label} seed ${seed}: size ${d.width}x${d.height}`);
    const v = verifyLinear(d);
    for (const e of v.errs.slice(0, 3)) fail(`${label} seed ${seed} (${d.width}x${d.height}): ${e}`);
    if (v.errs.length) continue;
    stats.okMaps = (stats.okMaps ?? 0) + 1;
    stats.rooms += v.n; stats.sides += v.sides; stats.loops += v.loops; stats.wide += v.stripWide ? 1 : 0;
    stats.dist += v.dist; stats.minDist = Math.min(stats.minDist, v.dist);
  }
}

configureWorld({ layout: 'linear' });
run('default', Array.from({ length: SEEDS }, (_, i) => i + 1));
configureWorld({ minSize: 25, maxSize: 25 });
run('25x25', Array.from({ length: 40 }, (_, i) => 1000 + i));
configureWorld({ minSize: 90, maxSize: 90 });
run('90x90', Array.from({ length: 20 }, (_, i) => 2000 + i));
configureWorld({ minSize: 120, maxSize: 120 });
run('120x120', Array.from({ length: 10 }, (_, i) => 2500 + i));
configureWorld({ minSize: 40, maxSize: 120 });
run('40..120', Array.from({ length: 30 }, (_, i) => 2600 + i));
// Skinny maps: sides drawn independently, so look for seeds with one short and one long side.
configureWorld({ minSize: 25, maxSize: 90 });
const skinny = [];
for (let s = 3000; skinny.length < 20 && s < 20000; s++) {
  const r = (() => { let a = s >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  const w = 25 + Math.floor(r() * 66), h = 25 + Math.floor(r() * 66);
  if (Math.min(w, h) <= 30 && Math.max(w, h) >= 80) skinny.push(s);
}
if (skinny.length < 5) fail('found too few skinny seeds');
run('skinny', skinny);
// Narrowest rooms the knobs allow still give a valid layout.
configureWorld({ roomMin: 2, roomMax: 4 });
run('small rooms', Array.from({ length: 20 }, (_, i) => 4000 + i));
configureWorld({ roomMin: 10, roomMax: 30 });
run('big rooms', Array.from({ length: 20 }, (_, i) => 5000 + i));
configureWorld({ roomMin: 4, roomMax: 15 });
if (stats.wide < stats.maps / 2) fail(`only ${stats.wide} of ${stats.maps} maps have a corridor wider than 1`);
if (stats.loops === 0) fail('no map got a loop');

const ok = Math.max(1, stats.okMaps);
console.log(`maps ${stats.maps}: path rooms avg ${(stats.rooms / ok).toFixed(1)}, side rooms avg ${(stats.sides / ok).toFixed(1)}, ` +
  `loops ${stats.loops}, wide corridors in ${stats.wide}, start->portal steps avg ${(stats.dist / ok).toFixed(0)} (min ${stats.minDist}), ` +
  `generation avg ${(stats.ms / stats.maps).toFixed(1)} ms (max ${stats.maxMs.toFixed(1)} ms)`);
if (!QUIET) {
  for (const seed of [3, 12]) {
    const d = generateDungeon(seed);
    console.log(`\nseed ${seed} (${d.width}x${d.height}; S start, P portal, o solid prop)\n${ascii(d)}`);
  }
}
configureWorld({ layout: 'maze' });
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall linear layout checks passed');
