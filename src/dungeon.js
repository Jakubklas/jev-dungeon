// Dungeon rules: map generation, movement, permanent lighting and line of sight.
// No Jev knowledge lives here; perception.js decides what Jev may see.

import { placeProps } from './props/place.js';

export const LIGHT_RADIUS = 7;
export const SIGHT_RANGE = 7;
export const MIN_SIZE = 25;
export const MAX_SIZE = 90;
export const ROOM_MIN = 4; // room width and height are each ROOM_MIN..ROOM_MAX
export const ROOM_MAX = 15;
const ROOM_AREA = 290; // map cells per room when choosing the room count
const SPAWN_STEPS = 20; // mirrors MIN_SPAWN_STEPS in characters/adversary/adversary.js

export const DIRS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

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

export function createGame(dungeon) {
  let floorCount = 0;
  for (const row of dungeon.tiles) for (const c of row) if (c === '.') floorCount++;
  const game = {
    dungeon,
    pos: [...dungeon.start],
    steps: 0,
    visits: { [key(dungeon.start)]: 1 },
    light: Array.from({ length: dungeon.height }, () => Array(dungeon.width).fill(0)),
    knownCount: 0,
    knownFloor: 0, // running count of known floor cells (knownFloorCount reads it)
    litOutside: new Set(), // lit cells beyond the map edge (known rock)
    floorCount,
    won: false,
    lost: false,
    caughtBy: null,
    trail: [[...dungeon.start]],
    adversaries: [],
  };
  lightAround(game, game.pos);
  return game;
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

export function legalMoves(game) {
  if (game.won || game.lost) return [];
  const [x, y] = game.pos;
  return Object.keys(DIRS).filter((d) => isFloor(game.dungeon, [x + DIRS[d][0], y + DIRS[d][1]]));
}

// One step. Illegal moves (into a wall) and moves once the game is won or lost do nothing.
export function applyMove(game, dir) {
  if (game.won || game.lost || !legalMoves(game).includes(dir)) {
    return { moved: false, revealed: 0, revisit: false, won: game.won };
  }
  const next = [game.pos[0] + DIRS[dir][0], game.pos[1] + DIRS[dir][1]];
  const k = key(next);
  const revisit = (game.visits[k] ?? 0) > 0;
  game.visits[k] = (game.visits[k] ?? 0) + 1;
  game.pos = next;
  game.steps++;
  game.trail.push([...next]);
  const revealed = lightAround(game, next);
  game.won = same(next, game.dungeon.treasure);
  return { moved: true, revealed, revisit, won: game.won };
}

// Known = lit. Cells past the map edge are rock: known once lit, unknown otherwise,
// exactly like rock inside the map, so perception cannot tell where the edge is.
export function isKnown(game, [x, y]) {
  if (!inBounds(game.dungeon, [x, y])) return game.litOutside?.has(key([x, y])) ?? false;
  return game.light[y][x] > 0;
}

export function knownTile(game, [x, y]) {
  if (!isKnown(game, [x, y])) return null;
  return inBounds(game.dungeon, [x, y]) ? game.dungeon.tiles[y][x] : '#';
}

export function knownFloorCount(game) {
  return game.knownFloor;
}

export function exploredPct(game) {
  return Math.round((knownFloorCount(game) / game.floorCount) * 100);
}

// Everything the browser needs. The full map is included only so the UI can offer
// a debug "reveal map" toggle; the canvas should draw from `light` by default.
// `light` is stored rounded to 2 decimals already; this hands out a copy.
export function publicView(game) {
  const { seed, width, height, tiles, start, treasure } = game.dungeon;
  return {
    seed, width, height, tiles, start, treasure,
    props: game.dungeon.props ?? [],
    decor: game.dungeon.decor ?? [],
    pos: game.pos,
    steps: game.steps,
    won: game.won,
    lost: game.lost,
    light: game.light.map((row) => row.slice()),
    visits: game.visits,
    trail: game.trail,
    explored_pct: exploredPct(game),
  };
}
