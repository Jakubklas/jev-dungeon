// Placement checks for the linear layout (dungeon.layout.kind 'linear'): monster spawns, opening coins and hearts.
// Runs on hand-built linear dungeons (no dependency on the generator), plus generated seeds when the linear
// generator is there. Free, no Jev. Run from the dungeon-game directory: node scripts/check-linear-spawn.mjs
process.env.JEV_CONFIG = 'none';
globalThis.fetch = () => { throw new Error('fetch called: this check must never reach Jev'); };

const dungeonMod = await import('../src/dungeon.js');
const { spawnAdversaries } = await import('../src/characters/adversary/adversary.js');
const { spawnCoins } = await import('../src/coins.js');
const { spawnHearts } = await import('../src/hearts.js');

let failures = 0;
const fail = (msg) => { failures++; if (failures <= 20) console.error('FAIL:', msg); };
const inRect = ([x, y], r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const roomOf = (d, c) => d.rooms.findIndex((r) => inRect(c, r));

// A row of five 12x10 path rooms joined by 1-wide corridors, plus two side rooms above rooms 2 and 3.
function handBuilt(seed) {
  const W = 82, H = 20;
  const g = Array.from({ length: H }, () => Array(W).fill('#'));
  const carve = (r) => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) g[y][x] = '.'; };
  const path = [2, 18, 34, 50, 66].map((x, i) => ({ x, y: 8, w: 12, h: 10, role: i === 0 ? 'start' : i === 4 ? 'portal' : 'path', order: i }));
  const sides = [{ x: 37, y: 1, w: 6, h: 4, role: 'side', order: 2 }, { x: 53, y: 1, w: 6, h: 4, role: 'side', order: 3 }];
  for (const r of [...path, ...sides]) carve(r);
  for (let i = 0; i < 4; i++) for (let x = path[i].x + path[i].w; x < path[i + 1].x; x++) g[12][x] = '.';
  for (const s of sides) for (let y = s.y + s.h; y < 8; y++) g[y][s.x + 2] = '.';
  const rooms = [...path, ...sides];
  return {
    seed, width: W, height: H, tiles: g.map((r) => r.join('')),
    start: [8, 12], treasure: [72, 12], rooms, props: [], decor: [],
    layout: { kind: 'linear', patches: rooms.map((r) => ({ ...r })), links: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5], [3, 6]] },
  };
}

// The shared placement assertions for one linear dungeon.
const stats = { maps: 0, portalGuarded: 0, portalPossible: 0, sideGuards: 0, sideRooms: 0, coins: 0, sideCoins: 0, sideCells: 0, floorCells: 0, hearts: 0, heartsSide: 0 };
function checkOne(d, id) {
  stats.maps++;
  const advs = spawnAdversaries(d);
  const again = spawnAdversaries(d);
  if (JSON.stringify(advs.map((a) => [a.id, a.pos, a.kind, a.level])) !== JSON.stringify(again.map((a) => [a.id, a.pos, a.kind, a.level]))) fail(`${id}: spawns not deterministic`);
  const cells = new Set();
  for (const a of advs) {
    const k = a.pos.join(',');
    if (cells.has(k)) fail(`${id}: two monsters on ${k}`);
    cells.add(k);
    if (d.tiles[a.pos[1]][a.pos[0]] !== '.') fail(`${id}: monster on a wall at ${k}`);
    const ri = roomOf(d, a.pos);
    if (ri >= 0 && d.rooms[ri].role === 'start') fail(`${id}: monster in the start room at ${k}`);
  }
  const portal = d.rooms.findIndex((r) => r.role === 'portal');
  const dist = dungeonMod.floorDistances(d, d.start);
  const okCell = (c) => (dist.get(c.join(',')) ?? -1) >= dungeonMod.SPAWN_STEPS &&
    !(Math.hypot(c[0] - d.start[0], c[1] - d.start[1]) <= dungeonMod.SIGHT_RANGE && dungeonMod.hasLineOfSight(d, d.start, c));
  let portalOk = false;
  const pr = d.rooms[portal];
  for (let y = pr.y; y < pr.y + pr.h && !portalOk; y++) for (let x = pr.x; x < pr.x + pr.w; x++) if (d.tiles[y][x] === '.' && okCell([x, y])) { portalOk = true; break; }
  if (portalOk && advs.length) {
    stats.portalPossible++;
    if (advs.some((a) => roomOf(d, a.pos) === portal)) stats.portalGuarded++;
    else fail(`${id}: portal room has an ok cell but no monster`);
  }
  d.rooms.forEach((r, i) => {
    if (r.role !== 'side') return;
    stats.sideRooms++;
    if (advs.some((a) => roomOf(d, a.pos) === i)) stats.sideGuards++;
  });
  // Coins and hearts: side rooms favoured.
  const coins = spawnCoins(d);
  if (JSON.stringify(coins) !== JSON.stringify(spawnCoins(d))) fail(`${id}: coins not deterministic`);
  stats.coins += coins.length;
  stats.sideCoins += coins.filter((c) => d.rooms[roomOf(d, c)]?.role === 'side').length;
  for (const [i, r] of d.rooms.entries()) {
    let n = 0;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (d.tiles[y][x] === '.') n++;
    stats.floorCells += n;
    if (r.role === 'side') stats.sideCells += n;
    void i;
  }
  const withCoins = { ...d, coins };
  const hearts = spawnHearts(withCoins);
  stats.hearts += hearts.length;
  const sideCount = d.rooms.filter((r) => r.role === 'side').length;
  const heartSide = hearts.filter((c) => d.rooms[roomOf(d, c)]?.role === 'side').length;
  stats.heartsSide += heartSide;
  if (heartSide < Math.min(sideCount, hearts.length)) fail(`${id}: hearts skipped a side room (${heartSide} of ${hearts.length} in side rooms, ${sideCount} side rooms)`);
}

// 1. Hand-built linear dungeons over many seeds.
for (let seed = 1; seed <= 200; seed++) checkOne(handBuilt(seed), `hand-built seed ${seed}`);
const hand = { ...stats };
console.log(`hand-built: ${hand.maps} maps, portal guarded ${hand.portalGuarded}/${hand.portalPossible}, side guardians ${hand.sideGuards}/${hand.sideRooms}, coins in side rooms ${(100 * hand.sideCoins / Math.max(1, hand.coins)).toFixed(0)}% (side rooms hold ${(100 * hand.sideCells / hand.floorCells).toFixed(0)}% of room floor), hearts in side rooms ${hand.heartsSide}/${hand.hearts}`);
const share = hand.sideGuards / hand.sideRooms;
if (share < 0.35 || share > 0.65) fail(`side-room guardian share ${share.toFixed(2)}, expected about 0.5`);
if (hand.sideCoins / hand.coins <= hand.sideCells / hand.floorCells) fail('side rooms are not favoured for coins');

// 2. A maze dungeon (no layout) keeps the old placement: same as the same dungeon with layout removed explicitly.
for (let seed = 1; seed <= 20; seed++) {
  const d = dungeonMod.generateDungeon(seed);
  if (d.layout?.kind === 'linear') continue;
  const plain = { ...d };
  delete plain.layout;
  if (JSON.stringify(spawnAdversaries(d).map((a) => a.pos)) !== JSON.stringify(spawnAdversaries(plain).map((a) => a.pos))) fail(`maze seed ${seed}: spawns depend on layout`);
}

// 3. Generated linear dungeons, when the generator has the layout knob.
let generated = 0;
try {
  dungeonMod.configureWorld({ layout: 'linear' });
  for (let seed = 1; seed <= 100; seed++) {
    const d = dungeonMod.generateDungeon(seed);
    if (d.layout?.kind !== 'linear') break;
    generated++;
    checkOne(d, `generated seed ${seed}`);
  }
} finally {
  dungeonMod.configureWorld({ layout: 'maze' });
}
if (generated) {
  const g = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, v - hand[k]]));
  console.log(`generated: ${g.maps} maps, portal guarded ${g.portalGuarded}/${g.portalPossible}, side guardians ${g.sideGuards}/${g.sideRooms}, coins in side rooms ${(100 * g.sideCoins / Math.max(1, g.coins)).toFixed(0)}% (side rooms hold ${(100 * g.sideCells / Math.max(1, g.floorCells)).toFixed(0)}% of room floor), hearts in side rooms ${g.heartsSide}/${g.hearts}`);
} else console.log('generated: skipped (no linear generator yet)');

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('check-linear-spawn: all OK');
