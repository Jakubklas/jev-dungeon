// Dungeon rules: map generation, movement, permanent lighting and line of sight, plus the `Game`
// class (one game's state and its methods). Game lives here, not in its own file, because
// scripts/check-props.mjs copies this file alone to a temp dir: keep it free of other relative imports.
// No Jev knowledge lives here; perception.js decides what Jev may see.

import { placeProps } from './props/place.js';

// `export let` on purpose: src/settings.js changes these through configureWorld(), and every importer sees the live value.
export let LIGHT_RADIUS = 7;
export let SIGHT_RANGE = 7;
export let MIN_SIZE = 25;
export let MAX_SIZE = 90;
export const ROOM_MIN = 4; // room width and height are each ROOM_MIN..ROOM_MAX
export const ROOM_MAX = 15;
export let EXPLORER_LIVES = 2; // lives the explorer starts with
let ROOM_AREA = 290; // map cells per room when choosing the room count

// Settings hook (src/settings.js). Light radius, lives, size range and room area only matter to a game
// that starts afterwards; sight range is read every tick.
export function configureWorld(o) {
  if (o.lightRadius !== undefined) LIGHT_RADIUS = o.lightRadius;
  if (o.sightRange !== undefined) SIGHT_RANGE = o.sightRange;
  if (o.minSize !== undefined) MIN_SIZE = o.minSize;
  if (o.maxSize !== undefined) MAX_SIZE = o.maxSize;
  if (o.lives !== undefined) EXPLORER_LIVES = o.lives;
  if (o.roomArea !== undefined) ROOM_AREA = o.roomArea;
}
const SPAWN_STEPS = 20; // mirrors MIN_SPAWN_STEPS in characters/adversary/adversary.js

export const DIRS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

// The explorer's non-move: not a direction, so it is not in DIRS (which perception walks to find neighbours).
export const STAY = 'stay';

const STEPS = Object.values(DIRS);
const key = ([x, y]) => `${x},${y}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const inBounds = (dungeon, [x, y]) => x >= 0 && x < dungeon.width && y >= 0 && y < dungeon.height;

// mulberry32: small seeded PRNG so a seed always rebuilds the same dungeon.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSeed() {
  return Math.floor(Math.random() * 2 ** 32);
}

// BFS over floor on a flat index grid (i = y * width + x). Returns Int32Array, -1 = unreachable.
function bfs(width, height, isOpen, fromIdx) {
  const dist = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  dist[fromIdx] = 0;
  queue[tail++] = fromIdx;
  while (head < tail) {
    const i = queue[head++];
    const x = i % width, d = dist[i] + 1;
    // Neighbours: up, down, left, right (bounds-checked).
    if (i >= width && dist[i - width] < 0 && isOpen(i - width)) { dist[i - width] = d; queue[tail++] = i - width; }
    if (i + width < width * height && dist[i + width] < 0 && isOpen(i + width)) { dist[i + width] = d; queue[tail++] = i + width; }
    if (x > 0 && dist[i - 1] < 0 && isOpen(i - 1)) { dist[i - 1] = d; queue[tail++] = i - 1; }
    if (x < width - 1 && dist[i + 1] < 0 && isOpen(i + 1)) { dist[i + 1] = d; queue[tail++] = i + 1; }
  }
  return { dist, order: queue.subarray(0, tail) };
}

// Shortest-path step counts from `from` over the real floor (for adversaries, never for perception).
export function floorDistances(dungeon, from) {
  const { width, height, tiles } = dungeon;
  const out = new Map();
  if (!isFloor(dungeon, from)) return out;
  const { dist, order } = bfs(width, height, (i) => tiles[(i / width) | 0].charCodeAt(i % width) === 46, from[1] * width + from[0]);
  for (const i of order) out.set(`${i % width},${(i / width) | 0}`, dist[i]);
  return out;
}

// Rooms are placed at random without overlapping, then joined by L-shaped corridors along a
// minimum spanning tree of room centres (always connected, corridors stay local), plus extra
// corridors to near neighbours for loops. The outer ring stays wall, so neighbours of a floor
// cell are always in bounds. Room count and corridors scale with area.
function carve(rand, width, height) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const grid = Array.from({ length: height }, () => Array(width).fill('#'));
  const area = width * height;
  // Rooms are 4-15 a side, so each takes ~110 cells with its wall margin: one room per
  // ~ROOM_AREA cells keeps a similar packing density to the old 3-9 x 3-7 rooms.
  const targetRooms = Math.max(4, Math.round(area / ROOM_AREA));
  const rooms = [];
  for (let tries = 0; tries < targetRooms * 25 && rooms.length < targetRooms; tries++) {
    const w = int(ROOM_MIN, ROOM_MAX), h = int(ROOM_MIN, ROOM_MAX);
    const x = int(1, width - w - 1), y = int(1, height - h - 1);
    // Keep at least one wall cell between rooms.
    const clash = rooms.some((r) => x <= r.x + r.w && r.x <= x + w && y <= r.y + r.h && r.y <= y + h);
    if (!clash) rooms.push({ x, y, w, h });
  }
  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid[y][x] = '.';
  }

  const center = (r) => [r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2)];
  const corridor = (a, b) => {
    const [ax, ay] = center(a), [bx, by] = center(b);
    // Horizontal leg then vertical, or the other way round.
    const horizontalFirst = rand() < 0.5;
    const rowY = horizontalFirst ? ay : by;
    const colX = horizontalFirst ? bx : ax;
    for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) grid[rowY][x] = '.';
    for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) grid[y][colX] = '.';
  };
  const gap = (a, b) => {
    const [ax, ay] = center(a), [bx, by] = center(b);
    return Math.abs(ax - bx) + Math.abs(ay - by);
  };

  // Prim's MST over room centres (n is at most ~200, so O(n^2) is fine).
  const n = rooms.length;
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const linked = new Set();
  best[0] = 0;
  for (let k = 0; k < n; k++) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i;
    inTree[u] = 1;
    if (parent[u] >= 0) {
      corridor(rooms[parent[u]], rooms[u]);
      linked.add(`${Math.min(u, parent[u])}-${Math.max(u, parent[u])}`);
    }
    for (let i = 0; i < n; i++) {
      const g = gap(rooms[u], rooms[i]);
      if (!inTree[i] && g < best[i]) { best[i] = g; parent[i] = u; }
    }
  }
  // Loops: link random rooms to one of their 2nd-4th nearest rooms, about n/4 times (at least 2).
  const loops = Math.max(2, Math.round(n / 4));
  for (let i = 0, made = 0; i < loops * 4 && made < loops && n > 3; i++) {
    const a = int(0, n - 1);
    const near = rooms.map((r, j) => [gap(rooms[a], r), j]).filter(([, j]) => j !== a).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const b = near[int(1, Math.min(3, near.length - 1))][1];
    const id = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (linked.has(id)) continue;
    linked.add(id);
    corridor(rooms[a], rooms[b]);
    made++;
  }
  return { grid, rooms, center };
}

export function generateDungeon(seed = randomSeed()) {
  const rand = rng(seed);
  // Size comes first so it depends on the seed alone.
  const width = MIN_SIZE + Math.floor(rand() * (MAX_SIZE - MIN_SIZE + 1));
  const height = MIN_SIZE + Math.floor(rand() * (MAX_SIZE - MIN_SIZE + 1));
  // Retry on the same PRNG stream in the rare case a layout comes out unusable.
  for (;;) {
    const { grid, rooms, center } = carve(rand, width, height);
    if (rooms.length < 4) continue;
    const start = center(rooms[Math.floor(rand() * rooms.length)]);
    const { dist } = bfs(width, height, (i) => grid[(i / width) | 0][i % width] === '.', start[1] * width + start[0]);
    let maxD = 0;
    for (let i = 0; i < dist.length; i++) if (dist[i] > maxD) maxD = dist[i];
    // The chest sits in a room, at a path distance of at least 60% of the farthest cell.
    const pool = [];
    let spawnable = false;
    for (const r of rooms) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const d = dist[y * width + x];
          if (d > 0 && d >= 0.6 * maxD) pool.push([x, y]);
          if (!spawnable && d >= SPAWN_STEPS && !(Math.hypot(x - start[0], y - start[1]) <= SIGHT_RANGE &&
            hasLineOfSight({ width, height, tiles: grid }, start, [x, y]))) spawnable = true;
        }
      }
    }
    // Adversaries need a room cell at least SPAWN_STEPS from start and out of its sight.
    if (!pool.length || !spawnable) continue;
    pool.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const treasure = pool[Math.floor(rand() * pool.length)];
    const dungeon = {
      seed, width, height,
      tiles: grid.map((row) => row.join('')),
      start, treasure,
      rooms: rooms.map((r) => ({ ...r })),
    };
    // Props come last, from their own PRNG, so layout, start and treasure never change.
    const { tiles, props, decor } = placeProps(dungeon, rng(seed ^ 0x2c1b3c6d));
    return { ...dungeon, tiles, props, decor };
  }
}

// Lights every cell within LIGHT_RADIUS of `at`. Brightness only ever goes up.
// Cells past the map edge are solid rock: once lit they count as known wall (see isKnown),
// so the edge of the map looks exactly like any other rock. Returns how many in-map cells
// went from unknown to known.
function lightAround(game, [cx, cy]) {
  let revealed = 0;
  const { dungeon } = game;
  for (let y = cy - LIGHT_RADIUS; y <= cy + LIGHT_RADIUS; y++) {
    for (let x = cx - LIGHT_RADIUS; x <= cx + LIGHT_RADIUS; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > LIGHT_RADIUS) continue;
      if (!inBounds(dungeon, [x, y])) {
        game.litOutside.add(key([x, y]));
        continue;
      }
      const b = Math.round((1 - d / (LIGHT_RADIUS + 1)) * 100) / 100;
      if (game.light[y][x] === 0) {
        revealed++;
        game.knownCount++;
        if (dungeon.tiles[y][x] === '.') game.knownFloor++;
      }
      if (b > game.light[y][x]) game.light[y][x] = b;
    }
  }
  return revealed;
}

// Real tiles: for adversary movement, never for explorer perception.
export function isFloor(dungeon, [x, y]) {
  return inBounds(dungeon, [x, y]) && dungeon.tiles[y][x] === '.';
}

// Supercover line between cell centres: every cell the segment touches, and both side cells
// where it passes exactly through a corner. Any '#' strictly between a and b blocks. The cell
// set is a property of the segment, and the endpoints are put in a fixed order, so the result
// is symmetric.
export function hasLineOfSight(dungeon, a, b) {
  if (a[1] > b[1] || (a[1] === b[1] && a[0] > b[0])) [a, b] = [b, a];
  const wall = ([x, y]) => !inBounds(dungeon, [x, y]) || dungeon.tiles[y][x] === '#';
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const nx = Math.abs(dx), ny = Math.abs(dy);
  const sx = Math.sign(dx), sy = Math.sign(dy);
  let x = a[0], y = a[1];
  for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
    const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (decision === 0) {
      // Exactly through a corner: both side cells must be open.
      if (wall([x + sx, y]) || wall([x, y + sy])) return false;
      x += sx; y += sy; ix++; iy++;
    } else if (decision < 0) {
      x += sx; ix++;
    } else {
      y += sy; iy++;
    }
    if ((x !== b[0] || y !== b[1]) && wall([x, y])) return false;
  }
  return true;
}

// The game state and everything that mutates or reads it directly. It lives in this file (not its
// own) because scripts/check-props.mjs copies dungeon.js to a temp dir. Fields are public on
// purpose: the check scripts set them directly. Never JSON-clone or spread one: `litOutside` is a
// Set and the methods live on the prototype (use `twin`).
export class Game {
  constructor(dungeon) {
    let floorCount = 0;
    for (const row of dungeon.tiles) for (const c of row) if (c === '.') floorCount++;
    this.dungeon = dungeon;
    this.pos = [...dungeon.start];
    this.steps = 0;
    this.visits = { [key(dungeon.start)]: 1 };
    this.light = Array.from({ length: dungeon.height }, () => Array(dungeon.width).fill(0));
    this.knownCount = 0;
    this.knownFloor = 0; // running count of known floor cells (knownFloorCount reads it)
    this.litOutside = new Set(); // lit cells beyond the map edge (known rock)
    this.floorCount = floorCount;
    this.won = false;
    this.lost = false;
    this.caughtBy = null;
    this.health = EXPLORER_LIVES;
    this.maxHealth = EXPLORER_LIVES;
    this.graceTicks = 0; // ticks of hit protection left (adversary.js GRACE_TICKS counts it down)
    this.trail = [[...dungeon.start]];
    this.adversaries = [];
    this.adversaryTicks = 0; // world ticks the adversaries have run (adversary.js)
    this.patrolRand = null; // per-game patrol RNG, created on the first patrol goal (adversary.js)
    lightAround(this, this.pos);
  }

  // Shallow copy like the old `{ ...game, ...overrides }` spread: arrays and objects not in
  // `overrides` are shared. Keeps the prototype so methods work. `litOutside` must be a Set.
  // Only the fog twin tests use it.
  twin(overrides = {}) {
    return Object.assign(Object.create(Game.prototype), this, overrides);
  }

  // Takes lives off the explorer. The game is lost (caughtBy = sourceId) only when health hits 0.
  // No-op once won or lost. Returns the state after the hit.
  damage(amount = 1, sourceId = null) {
    if (this.won || this.lost) return { health: this.health, lost: this.lost };
    this.health = Math.max(0, this.health - amount);
    if (this.health === 0) {
      this.lost = true;
      this.caughtBy = sourceId;
    }
    return { health: this.health, lost: this.lost };
  }

  legalMoves() {
    if (this.won || this.lost) return [];
    const [x, y] = this.pos;
    return Object.keys(DIRS).filter((d) => isFloor(this.dungeon, [x + DIRS[d][0], y + DIRS[d][1]]));
  }

  // The explorer's per-tick options: every legal step plus STAY (stand still). Empty once the game is over.
  availableMoves() {
    const steps = this.legalMoves();
    return steps.length ? [...steps, STAY] : steps;
  }

  // One step. Illegal moves (into a wall) and moves once the game is won or lost do nothing.
  // STAY keeps the position: the tick still counts as a step, but nothing is revealed or revisited.
  applyMove(dir) {
    if (dir === STAY && !this.won && !this.lost) {
      this.steps++;
      return { moved: false, stayed: true, revealed: 0, revisit: false, won: this.won };
    }
    if (this.won || this.lost || !this.legalMoves().includes(dir)) {
      return { moved: false, revealed: 0, revisit: false, won: this.won };
    }
    const next = [this.pos[0] + DIRS[dir][0], this.pos[1] + DIRS[dir][1]];
    const k = key(next);
    const revisit = (this.visits[k] ?? 0) > 0;
    this.visits[k] = (this.visits[k] ?? 0) + 1;
    this.pos = next;
    this.steps++;
    this.trail.push([...next]);
    const revealed = lightAround(this, next);
    this.won = !!this.dungeon.treasure && same(next, this.dungeon.treasure); // testbed arenas may have no chest
    return { moved: true, revealed, revisit, won: this.won };
  }

  // Known = lit. Cells past the map edge are rock: known once lit, unknown otherwise,
  // exactly like rock inside the map, so perception cannot tell where the edge is.
  isKnown([x, y]) {
    if (!inBounds(this.dungeon, [x, y])) return this.litOutside.has(key([x, y]));
    return this.light[y][x] > 0;
  }

  knownTile([x, y]) {
    if (!this.isKnown([x, y])) return null;
    return inBounds(this.dungeon, [x, y]) ? this.dungeon.tiles[y][x] : '#';
  }

  knownFloorCount() {
    return this.knownFloor;
  }

  exploredPct() {
    return Math.round((this.knownFloorCount() / this.floorCount) * 100);
  }

  // Everything the browser needs. The full map is included only so the UI can offer
  // a debug "reveal map" toggle; the canvas should draw from `light` by default.
  // `light` is stored rounded to 2 decimals already; this hands out a copy.
  publicView() {
    const { seed, width, height, tiles, start, treasure } = this.dungeon;
    return {
      seed, width, height, tiles, start, treasure,
      props: this.dungeon.props ?? [],
      decor: this.dungeon.decor ?? [],
      pos: this.pos,
      steps: this.steps,
      won: this.won,
      lost: this.lost,
      health: this.health,
      max_health: this.maxHealth,
      light: this.light.map((row) => row.slice()),
      visits: this.visits,
      trail: this.trail,
      explored_pct: this.exploredPct(),
    };
  }
}
