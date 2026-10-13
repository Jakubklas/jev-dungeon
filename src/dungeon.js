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
export let ROOM_MIN = 4; // room width and height are each ROOM_MIN..ROOM_MAX
export let ROOM_MAX = 15;
export let MIN_ROOMS = 4; // fewest rooms a map gets (a layout with fewer is redrawn)
export let LOOP_SHARE = 0.25; // extra loop corridors as a share of the rooms ...
export let LOOP_MIN = 2; // ... and at least this many
export let TREASURE_SHARE = 0.6; // the portal sits at least this share of the farthest path distance from the start
export let EXPLORER_LIVES = 4; // lives the explorer starts with
export let LAYOUT = 'linear'; // 'maze': rooms joined by a spanning tree plus loops; 'linear': one winding path of rooms to the portal, with side rooms
export let HELP_REACH_STEPS = 48; // known-path steps within which a teammate gets a help report (several explorers; read by the multiplayer runtime)
export let REGEN_STEPS = 30; // the explorer heals REGEN_AMOUNT lives every this many steps (0 = never)
export let REGEN_AMOUNT = 0.5; // lives healed per regen (health may be fractional: 1.5 of 2)
export let STEP_MS = 400; // world-time length of one 'step' in ms: converts every step-count duration (rules.stepMs)
export let CADENCE_MS = 90; // an actor starts its next decision no sooner than this after the previous one (rules.cadenceMs; runtime)
export let HEART_RESPAWN = 200; // a picked-up heart comes back on its cell this many steps later (0 = never)
let ROOM_AREA = 290; // map cells per room when choosing the room count

// Settings hook (src/settings.js). Light radius, lives, size range and room area only matter to a game
// that starts afterwards; sight range is read every tick.
export function configureWorld(o) {
  if (o.lightRadius !== undefined) LIGHT_RADIUS = o.lightRadius;
  if (o.sightRange !== undefined) SIGHT_RANGE = o.sightRange;
  if (o.minSize !== undefined) MIN_SIZE = o.minSize;
  if (o.maxSize !== undefined) MAX_SIZE = o.maxSize;
  if (o.lives !== undefined) EXPLORER_LIVES = o.lives;
  if (o.regenSteps !== undefined) REGEN_STEPS = o.regenSteps;
  if (o.helpReachSteps !== undefined) HELP_REACH_STEPS = o.helpReachSteps;
  if (o.regenAmount !== undefined) REGEN_AMOUNT = o.regenAmount;
  if (o.heartRespawn !== undefined) HEART_RESPAWN = o.heartRespawn;
  if (o.stepMs !== undefined) STEP_MS = o.stepMs;
  if (o.cadenceMs !== undefined) CADENCE_MS = o.cadenceMs;
  if (o.roomArea !== undefined) ROOM_AREA = o.roomArea;
  if (o.roomMin !== undefined) ROOM_MIN = o.roomMin;
  if (o.roomMax !== undefined) ROOM_MAX = o.roomMax;
  if (o.minRooms !== undefined) MIN_ROOMS = o.minRooms;
  if (o.loopShare !== undefined) LOOP_SHARE = o.loopShare;
  if (o.loopMin !== undefined) LOOP_MIN = o.loopMin;
  if (o.treasureShare !== undefined) TREASURE_SHARE = o.treasureShare;
  if (o.spawnMinSteps !== undefined) SPAWN_STEPS = o.spawnMinSteps;
  if (o.layout !== undefined) LAYOUT = o.layout;
}
export let SPAWN_STEPS = 20; // mirrors MIN_SPAWN_STEPS in characters/adversary/adversary.js (both set from spawnMinSteps)

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
const round2 = (n) => Math.round(n * 100) / 100; // health can be fractional (regen); keep it free of float noise
const inBounds = (dungeon, [x, y]) => x >= 0 && x < dungeon.width && y >= 0 && y < dungeon.height;

// mulberry32: small seeded PRNG so a seed always rebuilds the same dungeon.
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.state = () => a;
  next.restore = (state) => {
    if (!Number.isInteger(state) || state < 0 || state > 0xffffffff) throw new TypeError('invalid RNG state');
    a = state >>> 0;
  };
  return next;
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
  const targetRooms = Math.max(MIN_ROOMS, Math.round(area / ROOM_AREA));
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
  const loops = Math.max(LOOP_MIN, Math.round(n * LOOP_SHARE));
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

// Linear layout (LAYOUT 'linear'): one winding path of rooms from the start to the portal, a few dead-end side
// rooms and at most one short loop. The map is cut into a coarse grid of patches with 2 wall cells between them;
// each room and everything it owns is carved inside its own patch, and a corridor only crosses the strip between
// two linked patches, so the room graph on the finished tiles is exactly the graph chosen here: the shape
// distortions (organic rooms, winding corridors 3-6 wide, a little narrower than the rooms they join) can never add a
// shortcut. A failed attempt is retried with weaker distortion; the last attempt (plain rectangles, straight corridors
// of the narrowest width) always succeeds.
const LINEAR_ATTEMPTS = 12;
const SPINE_SHARE = 0.6; // share of the patch grid the main path covers
const SPINE_BUDGET = 6000; // search nodes for the self-avoiding walk
const CORRIDOR_MIN = 3; // corridor brush width range (cells), capped below the smaller room it joins
const CORRIDOR_MAX = 6;

function generateLinear(seed, rand, width, height) {
  for (let attempt = 0; attempt < LINEAR_ATTEMPTS; attempt++) {
    const strength = attempt === LINEAR_ATTEMPTS - 1 ? 0 : 1 - attempt / (LINEAR_ATTEMPTS - 1);
    const built = buildLinear(rand, width, height, strength);
    if (!built) continue;
    const dungeon = { seed, width, height, tiles: built.grid.map((row) => row.join('')), start: built.start, treasure: built.treasure, rooms: built.rooms, layout: built.layout };
    // Props come last, from their own PRNG, so layout, start and treasure never change.
    const { tiles, props, decor } = placeProps(dungeon, rng(seed ^ 0x2c1b3c6d));
    return { ...dungeon, tiles, props, decor };
  }
  throw new Error(`linear layout failed for seed ${seed}`); // unreachable: the plain attempt cannot fail
}

function buildLinear(rand, width, height, strength) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const C = Math.max(9, Math.min(16, Math.round(Math.min(width, height) / 5)));
  const cols = Math.max(2, Math.floor((width - 2) / C)), rows = Math.max(2, Math.floor((height - 2) / C));
  const cw = Math.floor((width - 2) / cols), ch = Math.floor((height - 2) / rows);
  const N = cols * rows;
  const patchOf = (c) => ({ x: 2 + (c % cols) * cw, y: 2 + Math.floor(c / cols) * ch, w: cw - 2, h: ch - 2 });
  const gridNb = (c) => {
    const cx = c % cols, cy = Math.floor(c / cols), out = [];
    if (cy > 0) out.push(c - cols);
    if (cy < rows - 1) out.push(c + cols);
    if (cx > 0) out.push(c - 1);
    if (cx < cols - 1) out.push(c + 1);
    return out;
  };

  // 1. The main path: a self-avoiding walk over the patch grid from a border patch, keeping its heading half the time.
  const target = Math.max(3, Math.min(N - 1, Math.round(N * SPINE_SHARE)));
  const border = [];
  for (let c = 0; c < N; c++) if (c % cols === 0 || c % cols === cols - 1 || c < cols || c >= N - cols) border.push(c);
  const first = border[Math.floor(rand() * border.length)];
  const used = new Uint8Array(N);
  const path = [first];
  used[first] = 1;
  let best = [first], budget = SPINE_BUDGET;
  const walk = () => {
    if (path.length > best.length) best = [...path];
    if (path.length >= target || --budget <= 0) return path.length >= target;
    const here = path[path.length - 1];
    const nb = gridNb(here).filter((c) => !used[c]);
    for (let i = nb.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [nb[i], nb[j]] = [nb[j], nb[i]]; }
    if (path.length >= 2 && rand() < 0.5) {
      const straight = 2 * here - path[path.length - 2];
      const k = nb.indexOf(straight);
      if (k > 0) nb.unshift(...nb.splice(k, 1));
    }
    for (const c of nb) {
      path.push(c); used[c] = 1;
      if (walk()) return true;
      path.pop(); used[c] = 0;
    }
    return false;
  };
  walk();
  const spine = best;
  if (spine.length < 3) return null;
  used.fill(0);
  for (const c of spine) used[c] = 1;

  // Nodes: [patch cell, role, order]; links between node indices.
  const nodes = spine.map((c, i) => ({ cell: c, role: i === 0 ? 'start' : i === spine.length - 1 ? 'portal' : 'path', order: i }));
  const links = [];
  for (let i = 1; i < spine.length; i++) links.push([i - 1, i]);
  const spineAt = new Map(spine.map((c, i) => [c, i]));
  const addSide = (cell, order, linkTo) => {
    used[cell] = 1;
    nodes.push({ cell, role: 'side', order });
    for (const j of linkTo) links.push([j, nodes.length - 1]);
    return nodes.length - 1;
  };
  const wantSides = Math.min(5, Math.max(2, Math.round(N / 5)));
  let sides = 0;
  // 2. At most one loop: a free patch at an inside corner, linked to path[i] and path[i+2], so it bypasses one room.
  if (rand() < 0.5) {
    const corners = [];
    for (let c = 0; c < N; c++) {
      if (used[c]) continue;
      const on = gridNb(c).filter((n) => spineAt.has(n)).map((n) => spineAt.get(n)).sort((a, b) => a - b);
      for (let a = 0; a < on.length; a++) for (let b = a + 1; b < on.length; b++) if (on[b] - on[a] === 2) corners.push([c, on[a]]);
    }
    if (corners.length) {
      const [c, i] = corners[Math.floor(rand() * corners.length)];
      addSide(c, i, [i, i + 2]);
      sides++;
    }
  }
  // 3. Dead-end side rooms off any path room but the portal room, now and then two deep.
  while (sides < wantSides) {
    const cand = [];
    for (let c = 0; c < N; c++) {
      if (used[c]) continue;
      for (const n of gridNb(c)) if (spineAt.has(n) && spineAt.get(n) < spine.length - 1) cand.push([c, spineAt.get(n)]);
    }
    if (!cand.length) break;
    const [c, i] = cand[Math.floor(rand() * cand.length)];
    const s = addSide(c, i, [i]);
    sides++;
    if (sides < wantSides && rand() < 0.3) {
      const deeper = gridNb(c).filter((n) => !used[n]);
      if (deeper.length) { addSide(deeper[Math.floor(rand() * deeper.length)], i, [s]); sides++; }
    }
  }

  // 4. Rooms: a rectangle in its patch, then (with strength) lobes, edge noise and smoothing; the core stays floor.
  const grid = Array.from({ length: height }, () => Array(width).fill('#'));
  const rooms = [], patches = [], cores = [], rects = [];
  for (const node of nodes) {
    const p = patchOf(node.cell);
    const big = node.role === 'portal';
    // Rooms fill well under their patch, so the corridors between them have room to wind; the portal room is bigger.
    // At least 5 a side where the patch allows, so a 3-wide corridor is still narrower than the room it enters.
    const lo = (side) => Math.max(3, Math.min(side, big ? Math.ceil(side * 0.65) : Math.max(ROOM_MIN, 5, Math.ceil(side * 0.5))));
    const hi = (side) => Math.max(lo(side), Math.min(side, big ? Math.ceil(side * 0.85) : Math.min(ROOM_MAX, Math.ceil(side * 0.75))));
    const rw = int(lo(p.w), hi(p.w)), rh = int(lo(p.h), hi(p.h));
    const rx = int(p.x, p.x + p.w - rw), ry = int(p.y, p.y + p.h - rh);
    const mask = new Uint8Array(p.w * p.h);
    const at = (x, y) => (y - p.y) * p.w + (x - p.x);
    const inP = (x, y) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) mask[at(x, y)] = 1;
    if (strength > 0) {
      const lobes = 1 + (rand() < 0.5 ? 1 : 0);
      for (let l = 0; l < lobes; l++) {
        const ex = int(rx, rx + rw - 1), ey = rand() < 0.5 ? (rand() < 0.5 ? ry : ry + rh - 1) : int(ry, ry + rh - 1);
        const erx = 1.5 + rand() * 2 * strength, ery = 1.5 + rand() * 2 * strength;
        for (let y = Math.floor(ey - ery); y <= Math.ceil(ey + ery); y++) {
          for (let x = Math.floor(ex - erx); x <= Math.ceil(ex + erx); x++) {
            if (inP(x, y) && ((x - ex) / erx) ** 2 + ((y - ey) / ery) ** 2 <= 1) mask[at(x, y)] = 1;
          }
        }
      }
      // Edge noise in a 2-cell band around the rectangle's outline.
      for (let y = p.y; y < p.y + p.h; y++) {
        for (let x = p.x; x < p.x + p.w; x++) {
          const inside = x >= rx && x < rx + rw && y >= ry && y < ry + rh;
          const d = inside ? Math.min(x - rx, rx + rw - 1 - x, y - ry, ry + rh - 1 - y) : Math.max(rx - x, x - (rx + rw - 1), ry - y, y - (ry + rh - 1)) - 1;
          if (d <= 1 && rand() < 0.4 * strength) mask[at(x, y)] ^= 1;
        }
      }
      for (let pass = 0; pass < 2; pass++) {
        const next = mask.slice();
        for (let y = p.y; y < p.y + p.h; y++) {
          for (let x = p.x; x < p.x + p.w; x++) {
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && inP(x + dx, y + dy) && mask[at(x + dx, y + dy)]) n++;
            if (n >= 5) next[at(x, y)] = 1;
            else if (n <= 3) next[at(x, y)] = 0;
          }
        }
        mask.set(next);
      }
    }
    const cx = rx + Math.floor(rw / 2), cy = ry + Math.floor(rh / 2);
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) if (inP(x, y)) mask[at(x, y)] = 1;
    // Keep only the core's piece: smoothing can leave islands.
    const keep = new Uint8Array(mask.length);
    const stack = [at(cx, cy)];
    keep[stack[0]] = 1;
    let kept = 0;
    while (stack.length) {
      const i = stack.pop(), x = p.x + (i % p.w), y = p.y + Math.floor(i / p.w);
      kept++;
      for (const [dx, dy] of STEPS) {
        const nx = x + dx, ny = y + dy;
        if (inP(nx, ny) && mask[at(nx, ny)] && !keep[at(nx, ny)]) { keep[at(nx, ny)] = 1; stack.push(at(nx, ny)); }
      }
    }
    // Noise and smoothing can eat most of a small room; then it keeps its whole rectangle.
    if (kept < 0.6 * rw * rh) for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) keep[at(x, y)] = 1;
    let x0 = cx, x1 = cx, y0 = cy, y1 = cy;
    for (let i = 0; i < keep.length; i++) {
      if (!keep[i]) continue;
      const x = p.x + (i % p.w), y = p.y + Math.floor(i / p.w);
      grid[y][x] = '.';
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    rooms.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, role: node.role, order: node.order });
    patches.push(p);
    cores.push([cx, cy]);
    rects.push(Math.min(rw, rh, x1 - x0 + 1, y1 - y0 + 1)); // noise can leave the room thinner than its rectangle
  }

  // 5. Corridors: a walk with momentum and side-steps between two room cores, painted with a brush whose width
  // drifts between minW and maxW, kept inside the rectangle made of the two patches and the strip between them
  // (no other patch). Wide enough for 2-3 characters abreast, but a cell narrower than the smaller of the two rooms.
  for (const [a, b] of links) {
    const pa = patches[a], pb = patches[b];
    const maxW = Math.max(1, Math.min(CORRIDOR_MAX, Math.min(rects[a], rects[b]) - 1));
    const minW = Math.min(CORRIDOR_MIN, maxW);
    const R = { x0: Math.min(pa.x, pb.x), y0: Math.min(pa.y, pb.y), x1: Math.max(pa.x + pa.w, pb.x + pb.w) - 1, y1: Math.max(pa.y + pa.h, pb.y + pb.h) - 1 };
    const inR = (x, y) => x >= R.x0 && x <= R.x1 && y >= R.y0 && y <= R.y1;
    let [x, y] = cores[a];
    const [qx, qy] = cores[b];
    let w = strength > 0 ? int(minW, maxW) : minW;
    const paint = () => {
      const o = -Math.floor((w - 1) / 2);
      for (let dy = o; dy < o + w; dy++) for (let dx = o; dx < o + w; dx++) if (inR(x + dx, y + dy)) grid[y + dy][x + dx] = '.';
    };
    paint();
    const cap = 3 * (Math.abs(qx - x) + Math.abs(qy - y)) + 20;
    let axis = Math.abs(qx - x) >= Math.abs(qy - y) ? 0 : 1;
    for (let step = 0; x !== qx || y !== qy; step++) {
      const dx = qx - x, dy = qy - y;
      if (strength > 0 && step < cap && rand() < 0.25 * strength) {
        // Side-step across the current heading, only while the whole brush stays inside R (a clipped brush pinches).
        const s = rand() < 0.5 ? -1 : 1;
        const o = -Math.floor((w - 1) / 2), e = s < 0 ? o - 1 : o + w;
        if (axis === 0 && inR(x, y + e)) y += s;
        else if (axis === 1 && inR(x + e, y)) x += s;
      } else {
        if ((axis === 0 && !dx) || (axis === 1 && !dy) || (strength > 0 && rand() < 0.2)) axis = dx && (!dy || rand() < Math.abs(dx) / (Math.abs(dx) + Math.abs(dy))) ? 0 : 1;
        if (axis === 0 && dx) x += Math.sign(dx);
        else if (axis === 1 && dy) y += Math.sign(dy);
        else if (dx) x += Math.sign(dx);
        else y += Math.sign(dy);
      }
      if (strength > 0 && rand() < 0.15) w = Math.max(minW, Math.min(maxW, w + (rand() < 0.5 ? -1 : 1)));
      paint();
    }
  }

  // 6. A corridor can clip a corner of another room's box; join any such piece to the room inside the box (so a
  // room's floor connects within its box), carving only inside that box, i.e. inside the room's own patch.
  for (let k = 0; k < rooms.length; k++) {
    const r = rooms[k];
    const inB = (x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    for (;;) {
      const from = new Map([[`${cores[k][0]},${cores[k][1]}`, null]]);
      const queue = [cores[k]];
      for (let h = 0; h < queue.length; h++) {
        const [x, y] = queue[h];
        for (const [dx, dy] of STEPS) {
          const nx = x + dx, ny = y + dy;
          if (inB(nx, ny) && grid[ny][nx] === '.' && !from.has(`${nx},${ny}`)) { from.set(`${nx},${ny}`, null); queue.push([nx, ny]); }
        }
      }
      let loose = null;
      for (let y = r.y; y < r.y + r.h && !loose; y++) for (let x = r.x; x < r.x + r.w; x++) if (grid[y][x] === '.' && !from.has(`${x},${y}`)) { loose = [x, y]; break; }
      if (!loose) break;
      // Shortest route through the box (walls too) from the loose cell to the room; carve it.
      const prev = new Map([[`${loose[0]},${loose[1]}`, null]]);
      const q = [loose];
      let hit = null;
      for (let h = 0; h < q.length && !hit; h++) {
        const [x, y] = q[h];
        for (const [dx, dy] of STEPS) {
          const nx = x + dx, ny = y + dy, id = `${nx},${ny}`;
          if (!inB(nx, ny) || prev.has(id)) continue;
          prev.set(id, `${x},${y}`);
          if (from.has(id)) { hit = id; break; }
          q.push([nx, ny]);
        }
      }
      for (let id = hit; id; id = prev.get(id)) { const [x, y] = id.split(',').map(Number); grid[y][x] = '.'; }
    }
  }
  // Every room needs a wall facing it (top or left of its floor) for its torches; a room swallowed by its
  // corridors has none, so the attempt is redrawn (weaker distortion next time).
  for (const r of rooms) {
    let faced = false;
    for (let y = r.y; y < r.y + r.h && !faced; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (grid[y][x] === '.' && ((y === r.y && grid[y - 1][x] === '#') || (x === r.x && grid[y][x - 1] === '#'))) { faced = true; break; }
      }
    }
    if (!faced) return null;
  }

  // 7. Start, reachability, portal.
  const start = [...cores[0]];
  const isOpen = (i) => grid[(i / width) | 0][i % width] === '.';
  const { dist } = bfs(width, height, isOpen, start[1] * width + start[0]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (grid[y][x] === '.' && dist[y * width + x] < 0) grid[y][x] = '#';
  // The portal goes inside the portal room's box (not on a widened corridor stub elsewhere in its patch).
  const portalNode = spine.length - 1, pp = rooms[portalNode];
  const clear = [];
  let far = -1;
  for (let y = pp.y; y < pp.y + pp.h; y++) {
    for (let x = pp.x; x < pp.x + pp.w; x++) {
      let ok = dist[y * width + x] > 0;
      for (let dy = -1; ok && dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (grid[y + dy][x + dx] !== '.') { ok = false; break; }
      if (ok) { clear.push([x, y]); far = Math.max(far, dist[y * width + x]); }
    }
  }
  if (!clear.length) return null;
  const near = clear.filter(([x, y]) => dist[y * width + x] >= far * 0.9);
  const treasure = near[Math.floor(rand() * near.length)];

  // 8. Verify the path cannot be skipped: closing a path room's patch must cut the start off from the portal,
  // unless the loop bypasses that room.
  const bypassed = new Set();
  nodes.forEach((n, j) => {
    const ends = links.filter(([, l]) => l === j).map(([k]) => k);
    if (n.role === 'side' && ends.length === 2) bypassed.add(Math.min(...ends) + 1); // the loop's two path rooms are i and i + 2
  });
  for (let r = 1; r < portalNode; r++) {
    if (bypassed.has(r)) continue;
    const p = patches[r];
    const blocked = (i) => {
      const x = i % width, y = (i / width) | 0;
      return isOpen(i) && !(x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
    };
    if (bfs(width, height, blocked, start[1] * width + start[0]).dist[treasure[1] * width + treasure[0]] >= 0) return null;
  }
  return { grid, start, treasure, rooms, layout: { kind: 'linear', patches, links } };
}

export function generateDungeon(seed = randomSeed()) {
  const rand = rng(seed);
  // Size comes first so it depends on the seed alone.
  const width = MIN_SIZE + Math.floor(rand() * (MAX_SIZE - MIN_SIZE + 1));
  const height = MIN_SIZE + Math.floor(rand() * (MAX_SIZE - MIN_SIZE + 1));
  if (LAYOUT === 'linear') return generateLinear(seed, rand, width, height);
  // Retry on the same PRNG stream in the rare case a layout comes out unusable.
  for (;;) {
    const { grid, rooms, center } = carve(rand, width, height);
    if (rooms.length < MIN_ROOMS) continue;
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
          if (d > 0 && d >= TREASURE_SHARE * maxD) pool.push([x, y]);
          if (!spawnable && d >= SPAWN_STEPS && !(Math.hypot(x - start[0], y - start[1]) <= startSight() &&
            hasLineOfSight({ width, height, tiles: grid }, start, [x, y]))) spawnable = true;
        }
      }
    }
    // Adversaries need a room cell at least SPAWN_STEPS from start and out of its sight.
    if (!pool.length || !spawnable) continue;
    pool.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    // The portal is drawn 2x2 cells wide, so keep it a full cell clear of any wall (all 8
    // neighbours floor). Filtering the pool first leaves the rand() call count unchanged.
    const clear = pool.filter(([x, y]) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (grid[y + dy]?.[x + dx] !== '.') return false;
      return true;
    });
    const choices = clear.length ? clear : pool;
    const treasure = choices[Math.floor(rand() * choices.length)];
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

// How far the explorer sees from the start at step 0: an adversary is seen only on a lit cell, and
// at step 0 only the start's light disc is lit. Spawn rules use it, so a sight range above the light
// radius does not change any dungeon.
export function startSight() {
  return Math.min(SIGHT_RANGE, LIGHT_RADIUS);
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

// One explorer's own state (several can share a Game, PLAN-multiplayer). The legacy single-explorer
// fields of Game (pos, steps, health, ...) are accessors onto the primary (explorers[0]). Light, loot,
// monsters and the win are shared; everything here is personal. Lives in this file (no new relative import).
export class ExplorerState {
  constructor(id, start, lives = EXPLORER_LIVES) {
    this.id = id;
    this.pos = [...start];
    this.steps = 0; // its own decision counter
    this.visits = { [key(start)]: 1 };
    this.trail = [[...start]];
    this.health = lives;
    this.maxHealth = lives;
    this.regenAt = null; // the step of the last regen heal
    this.regenSlot = 0; // the regen period (REGEN_STEPS * stepMs of its time) it last checked: a new one is a heal chance
    this.graceUntil = -1; // world ms (game clock) up to and including which a hit cannot hurt it (Game.setGrace)
    this.facing = 'right';
    this.block = null; // shield stance: null | { effectiveness, until (ms on its time, Game.timeOf), until_step (informational) }
    this.coins = 0;
    this.heartAt = null; // the step a heart was last picked up
    this.status = 'active'; // 'active' | 'dead' | 'forfeited' | 'won'
    this.outcome = { strikes: 0, dispels: 0, diedAt: null, portal: false }; // for the ranking
  }

  serialize() { return { v: 1, ...structuredClone(Object.fromEntries(Object.entries(this))) }; }
  static restore(saved) {
    if (saved?.v !== 1 || !saved.id || !Array.isArray(saved.pos)) throw new TypeError('invalid explorer snapshot');
    const e = new ExplorerState(saved.id, saved.pos, saved.maxHealth);
    for (const [name, value] of Object.entries(saved)) if (name !== 'v') e[name] = structuredClone(value);
    return e;
  }
}

// The game state and everything that mutates or reads it directly. It lives in this file (not its
// own) because scripts/check-props.mjs copies dungeon.js to a temp dir. Fields are public on
// purpose: the check scripts set them directly. Never JSON-clone or spread one: `litOutside` is a
// Set and the methods live on the prototype (use `twin`).
export class Game {
  constructor(dungeon, { explorers = null } = {}) {
    let floorCount = 0;
    for (const row of dungeon.tiles) for (const c of row) if (c === '.') floorCount++;
    this.dungeon = dungeon;
    this.explorers = (explorers?.length ? explorers : [{ id: 'explorer', start: dungeon.start }]).map((e) => new ExplorerState(e.id, e.start ?? dungeon.start));
    if (new Set(this.explorers.map((e) => e.id)).size !== this.explorers.length) throw new Error('explorer ids must be unique');
    this.light = Array.from({ length: dungeon.height }, () => Array(dungeon.width).fill(0));
    this.knownCount = 0;
    this.knownFloor = 0; // running count of known floor cells (knownFloorCount reads it)
    this.litOutside = new Set(); // lit cells beyond the map edge (known rock)
    this.floorCount = floorCount;
    this.won = false;
    this.lost = false;
    this.caughtBy = null;
    this.adversaries = [];
    this.adversaryTicks = 0; // world ticks the adversaries have run (adversary.js)
    // World clock (PLAN-multiplayer WP-D). `clock` is world time in ms and starts at 0; `Run.playTurn` adds one stepMs per
    // turn, the hosted runtime (`managed`) sets it from its monotonic clock. Shared timers are deadlines on that
    // timeline; `freeze()` stops it, so every remaining duration survives a pause. See now() / timeOf().
    this.clock = 0;
    this.rules = { stepMs: STEP_MS, cadenceMs: CADENCE_MS };
    this.managed = false; // true: the runtime owns `clock` and deadlines read it directly
    this.frozen = false;
    this.inTick = false; // inside stepAdversaries (legacy tick)
    this.tickAt = 0; // the legacy tick's time in ms, valid while inTick
    this.patrolRand = null; // per-game patrol RNG, created on the first patrol goal (adversary.js)
    this.strikes = []; // strikes this tick: { by, cells, result } (src/skills/resolve.js)
    this.dispelled = []; // monsters dispelled this tick: { id, at } (resolve.js); the death cry reads it (monster morale)
    this.skillRand = null; // seeded block-roll stream, created on the first roll (skillRandom)
    this.coinPiles = (dungeon.coins ?? []).map((c) => [...c]); // coins on the floor, one [x, y] per coin (duplicates = a bigger pile); replaced, never spliced. Opening coins: src/coins.js
    this.heartPiles = (dungeon.hearts ?? []).map((c) => [...c]); // floating hearts: stepping on one restores a life (applyMove); replaced, never spliced. Testbed `hearts` option only
    this.heartsTaken = []; // picked-up hearts waiting to respawn: { cell: [x, y], due: ms on the picker's time } (HEART_RESPAWN * stepMs); replaced, never spliced
    this.winBy = null; // how the game was won: 'chest' (applyMove) or 'cleared' (the last adversary dispelled, resolve.js)
    this.coinRand = null; // seeded coin-drop stream, created on the first roll (coinRandom)
    for (const e of this.explorers) lightAround(this, e.pos); // shared, max-only light
  }

  serialize() {
    const fields = [
      'light', 'knownCount', 'knownFloor', 'floorCount', 'won', 'lost', 'caughtBy', 'adversaryTicks',
      'clock', 'rules', 'managed', 'frozen', 'inTick', 'tickAt', 'strikes', 'dispelled',
      'coinPiles', 'heartPiles', 'heartsTaken', 'winBy',
    ];
    const state = Object.fromEntries(fields.map((name) => [name, structuredClone(this[name])]));
    return { v: 1, dungeon: structuredClone(this.dungeon), explorers: this.explorers.map((e) => e.serialize()),
      adversaries: this.adversaries.map((a) => a.serialize()), litOutside: [...this.litOutside],
      rng: { patrol: this.patrolRand?.state() ?? null, skill: this.skillRand?.state() ?? null,
        coin: this.coinRand?.state() ?? null }, state };
  }

  // `restoreAdversary` is injected to keep dungeon.js independent of relative imports (check-props copies this file).
  static restore(saved, { restoreAdversary } = {}) {
    if (saved?.v !== 1 || !saved.dungeon || !Array.isArray(saved.explorers)) throw new TypeError('invalid game snapshot');
    const game = new Game(structuredClone(saved.dungeon), { explorers: saved.explorers.map((e) => ({ id: e.id, start: e.pos })) });
    game.explorers = saved.explorers.map((e) => ExplorerState.restore(e));
    for (const [name, value] of Object.entries(saved.state)) game[name] = structuredClone(value);
    game.litOutside = new Set(saved.litOutside);
    if (saved.adversaries.length && !restoreAdversary) throw new TypeError('restoreAdversary is required');
    game.adversaries = saved.adversaries.map((a) => restoreAdversary(a));
    for (const name of ['patrol', 'skill', 'coin']) {
      const state = saved.rng?.[name];
      if (state === null || state === undefined) continue;
      const stream = rng(0);
      stream.restore(state);
      game[`${name}Rand`] = stream;
    }
    return game;
  }

  // ---- World clock (WP-D) -------------------------------------------------------------------------------
  // Managed (hosted runtime): `clock` is the one timeline and every deadline reads it. Unmanaged (Run and the
  // check drivers): time is derived from the same counters the old step timers used, so the pace is exactly
  // the old one (under Run it equals `clock`): the tick's own time for monster-side timers (grace, stun),
  // the explorer's own step count for its own timers (skills, block, hearts, regen).
  worldTick() { return Math.floor(this.clock / this.rules.stepMs + 1e-9); }
  // The tick counter monsters age their memory by: the clock's tick when managed, else the legacy counter.
  monsterTick() { return this.managed ? this.worldTick() : this.adversaryTicks; }
  // Shared-world "now" in ms for monster-side deadlines: while a legacy tick runs, its own time; between ticks,
  // the time of the tick that comes next (an explorer's strike this turn stuns for the tick that follows).
  now() {
    if (this.managed) return this.clock;
    return this.inTick ? this.tickAt : (this.adversaryTicks + 1) * this.rules.stepMs;
  }
  // The time an explorer's own timers (cooldowns, block, hearts, regen) run on.
  timeOf(explorer = null) {
    return this.managed ? this.clock : this.explorer(explorer).steps * this.rules.stepMs;
  }
  // Moves world time forward by `ms` (ignored while frozen). Run adds one stepMs per turn; the runtime adds real time.
  advance(ms) {
    if (!this.frozen) this.clock += ms;
    return this.clock;
  }
  // Sets the world clock (managed mode); a frozen game ignores it. Deadlines keep their absolute value.
  setClock(ms) {
    if (!this.frozen && ms > this.clock) this.clock = ms;
    return this.clock;
  }
  // Pause: world time stops, so every deadline keeps its remaining ms. thaw() resumes.
  freeze() { this.frozen = true; return this.timersLeft(); }
  thaw() { this.frozen = false; }
  // Hit protection: reference time for set/read outside a tick is the last tick's time (managed: the clock).
  graceRef() {
    if (this.managed) return this.clock;
    return this.inTick ? this.tickAt : this.adversaryTicks * this.rules.stepMs;
  }
  setGrace(explorer, ticks) {
    this.explorer(explorer).graceUntil = this.graceRef() + ticks * this.rules.stepMs;
  }
  // Is the explorer protected at `at` ms (default now)? Inclusive of the last instant, like the old tick count.
  graceActive(explorer, at = this.now()) { return this.explorer(explorer).graceUntil >= at; }
  // Whole steps of protection left after the last tick (what the UI and the old `graceTicks` showed).
  graceLeftSteps(explorer = null) {
    const left = this.explorer(explorer).graceUntil - this.graceRef();
    return left <= 0 ? 0 : Math.ceil(left / this.rules.stepMs - 1e-9);
  }
  // Remaining ms of the game-owned deadlines, for pause displays and checks.
  timersLeft() {
    const out = { clock: this.clock, explorers: {}, hearts: this.heartsTaken.map((h) => h.due) };
    for (const e of this.explorers) {
      out.explorers[e.id] = { grace: Math.max(0, e.graceUntil - this.graceRef()), block: e.block ? Math.max(0, e.block.until - this.timeOf(e)) : 0 };
    }
    return out;
  }

  // The primary explorer (explorers[0]): what every legacy single-explorer field below reads and writes.
  get primary() { return this.explorers[0]; }
  // An explorer by id; no id (or the legacy default) means the primary. Unknown ids throw.
  explorer(id) {
    if (id === undefined || id === null) return this.explorers[0];
    if (typeof id === 'object') return id;
    const e = this.explorers.find((x) => x.id === id);
    if (!e) throw new Error(`unknown explorer ${id}`);
    return e;
  }
  // Explorers still in play (not dead, forfeited or through the portal), in list order.
  activeExplorers() { return this.explorers.filter((e) => e.status === 'active'); }

  // Shallow copy like the old `{ ...game, ...overrides }` spread: arrays and objects not in
  // `overrides` are shared. Keeps the prototype so methods work. `litOutside` must be a Set.
  // Each explorer is shallow-copied too, so overriding `pos` (an accessor onto the primary) on a twin
  // never moves the original's explorer. Only the fog twin tests use it.
  twin(overrides = {}) {
    const t = Object.assign(Object.create(Game.prototype), this);
    t.explorers = this.explorers.map((e) => Object.assign(Object.create(ExplorerState.prototype), e));
    return Object.assign(t, overrides);
  }

  // Takes lives off an explorer (the primary by default). The explorer dies at 0 health; the game is
  // lost (caughtBy = sourceId) when no explorer is left active. No-op once won or lost. Returns the state after the hit.
  damage(amount = 1, sourceId = null, explorerId = null) {
    const e = this.explorer(explorerId);
    if (this.won || this.lost || e.status !== 'active') return { health: e.health, lost: this.lost };
    e.health = Math.max(0, round2(e.health - amount));
    if (e.health === 0) {
      e.status = 'dead';
      e.outcome.diedAt = e.steps;
      if (!this.activeExplorers().length) {
        this.lost = true;
        this.caughtBy = sourceId;
      }
    }
    return { health: e.health, lost: this.lost };
  }

  // An explorer leaves the game (a player forfeits or is removed): it is no longer active, so it stops occupying a cell and
  // monsters stop targeting it. The game is lost when nobody active is left (and nobody has won). No-op once over.
  forfeit(explorerId) {
    const e = this.explorer(explorerId);
    if (this.won || this.lost || e.status !== 'active') return { lost: this.lost };
    e.status = 'forfeited';
    if (!this.activeExplorers().length) this.lost = true;
    return { lost: this.lost };
  }

  // Next number of the per-game skill RNG (block rolls). Its own stream, created on the first call, so
  // it never touches generateDungeon / spawnAdversaries rng order.
  skillRandom() {
    this.skillRand ??= rng(((this.dungeon.seed ?? 1) ^ 0x2545f491) >>> 0);
    return this.skillRand();
  }

  // Drop-chance stream for coins; separate from the dungeon, spawn and block streams (rule 8).
  coinRandom() {
    this.coinRand ??= rng(((this.dungeon.seed ?? 1) ^ 0x3c6ef372) >>> 0);
    return this.coinRand();
  }

  // Start-of-tick cleanup for skill state: strikes are per tick, a lapsed block goes (each explorer's own).
  clearTickState() {
    this.strikes = [];
    this.dispelled = [];
    this.inTick = false; // a new turn's explorer phase
    for (const e of this.explorers) if (e.block && !this.blockActive(e)) e.block = null;
  }

  // Is the explorer's shield stance still up? A stance carries `until` (ms on its time); one built by hand with only the
  // legacy `until_step` still works.
  blockActive(explorer = null) {
    const e = this.explorer(explorer);
    if (!e.block) return false;
    return e.block.until !== undefined ? this.timeOf(e) <= e.block.until : e.steps <= e.block.until_step;
  }

  // The active explorer standing on `cell`, other than `exceptId` (a teammate blocks a move into it).
  explorerAt(cell, exceptId = null) {
    return this.explorers.find((e) => (e.status === 'active' || e.status === 'won') && e.id !== exceptId && same(e.pos, cell)) ?? null;
  }

  // Whom a monster at `cell` reacts to: the nearest active explorer it can see (range, line of sight, its
  // own cell lit), else the nearest active one, else the primary. One explorer: always that explorer.
  // Full multi-target monster AI is a later step; this keeps every monster read explorer-parametric.
  targetExplorer(cell) {
    if (this.explorers.length === 1) return this.explorers[0];
    const live = this.explorers.filter((e) => e.status === 'active');
    if (live.length <= 1) return live[0] ?? this.explorers[0];
    const d = (e) => Math.hypot(e.pos[0] - cell[0], e.pos[1] - cell[1]);
    const nearest = (list) => list.reduce((best, e) => (d(e) < d(best) ? e : best));
    const seen = live.filter((e) => d(e) <= SIGHT_RANGE && this.isKnown(cell) && hasLineOfSight(this.dungeon, e.pos, cell));
    return nearest(seen.length ? seen : live);
  }

  // Steps the explorer could take: floor cells, never one holding another active explorer.
  legalMoves(explorerId = null) {
    const e = this.explorer(explorerId);
    if (this.won || this.lost || e.status !== 'active') return [];
    const [x, y] = e.pos;
    return Object.keys(DIRS).filter((d) => {
      const c = [x + DIRS[d][0], y + DIRS[d][1]];
      return isFloor(this.dungeon, c) && (this.explorers.length < 2 || !this.explorerAt(c, e.id));
    });
  }

  // The explorer's per-tick options: every legal step plus STAY (stand still). Empty once the game is over.
  availableMoves(explorerId = null) {
    const steps = this.legalMoves(explorerId);
    return steps.length ? [...steps, STAY] : steps;
  }

  // One turn of movement. Dash may cross up to four consecutive floor cells in that turn;
  // each crossed cell is visited, lit and collected, and a portal ends the move immediately.
  // STAY keeps the position: the tick still counts as a step, but nothing is revealed or revisited.
  // A cell holding another active explorer is not enterable (Dash stops before it). First applied pickup wins.
  applyMove(dir, distance = 1, explorerId = null) {
    this.inTick = false; // an explorer action opens a turn's explorer phase
    if (!Number.isInteger(distance) || distance < 1 || distance > 4) throw new RangeError('move distance must be 1..4');
    const e = this.explorer(explorerId);
    if (dir === STAY && !this.won && !this.lost && e.status === 'active') {
      e.steps++;
      const respawned = this.respawnHearts(e);
      const regen = this.regenerate(e);
      return { moved: false, stayed: true, revealed: 0, revisit: false, won: this.won, regen, respawned };
    }
    if (this.won || this.lost || !this.legalMoves(e).includes(dir)) {
      return { moved: false, revealed: 0, revisit: false, won: this.won };
    }
    e.steps++;
    let revealed = 0, revisit = false, coins = 0, healed = 0, respawned = 0, travelled = 0;
    e.facing = dir;
    for (let i = 0; i < distance; i++) {
      const next = [e.pos[0] + DIRS[dir][0], e.pos[1] + DIRS[dir][1]];
      if (!isFloor(this.dungeon, next) || this.explorerAt(next, e.id)) break;
      const k = key(next);
      revisit ||= (e.visits[k] ?? 0) > 0;
      e.visits[k] = (e.visits[k] ?? 0) + 1;
      e.pos = next;
      e.trail.push([...next]);
      travelled++;
      if (i === 0) respawned = this.respawnHearts(e); // before pickup, once per turn
      revealed += lightAround(this, next);
      const here = this.coinPiles.filter((c) => same(c, next)).length;
      if (here) {
        this.coinPiles = this.coinPiles.filter((c) => !same(c, next)); // replace: twin() shares the old array
        e.coins += here;
        coins += here;
      }
      if (e.health < e.maxHealth && this.heartPiles.some((c) => same(c, next))) { // a heart is only used up when it heals
        const taken = this.heartPiles.filter((c) => same(c, next));
        this.heartPiles = this.heartPiles.filter((c) => !same(c, next));
        if (HEART_RESPAWN > 0) this.heartsTaken = [...this.heartsTaken, ...taken.map(() => ({ cell: [...next], due: this.timeOf(e) + HEART_RESPAWN * this.rules.stepMs }))];
        e.heartAt = e.steps;
        const gain = round2(Math.min(e.maxHealth, e.health + 1) - e.health);
        e.health = round2(e.health + gain);
        healed = round2(healed + gain);
      }
      if (this.dungeon.treasure && same(next, this.dungeon.treasure)) {
        this.won = true;
        this.winBy = 'chest';
        e.outcome.portal = true;
        e.status = 'won';
        break;
      }
    }
    const regen = this.regenerate(e);
    return { moved: true, revealed, revisit, won: this.won, coins, healed, regen, respawned, ...(distance > 1 ? { travelled } : {}) };
  }

  // Picked-up hearts whose time has come go back on their own cell. One due on an active explorer's cell
  // waits until it stands elsewhere, so a heart never reappears under it. Called by applyMove after the
  // step is counted and before the pickup (a stay counts too). `by` is the explorer whose step clock reads
  // the due time (the primary by default). Returns how many came back.
  // The explorer is never told hearts respawn: it just sees one again once its cell is lit.
  respawnHearts(by = null) {
    if (!this.heartsTaken.length) return 0;
    const e = this.explorer(by);
    const back = this.heartsTaken.filter((h) => h.due <= this.timeOf(e) && !this.explorerAt(h.cell));
    if (!back.length) return 0;
    this.heartsTaken = this.heartsTaken.filter((h) => !back.includes(h)); // replace, never splice: twin() shares arrays
    this.heartPiles = [...this.heartPiles, ...back.map((h) => [...h.cell])];
    return back.length;
  }

  // Slow natural healing: every REGEN_STEPS steps a hurt, living explorer gets REGEN_AMOUNT lives back, up to max.
  // Called by applyMove after the step is counted (a stay counts too). Returns the lives healed (0 if none).
  regenerate(explorerId = null) {
    const e = this.explorer(explorerId);
    if (!REGEN_STEPS || !REGEN_AMOUNT) return 0;
    const slot = Math.floor(this.timeOf(e) / (REGEN_STEPS * this.rules.stepMs) + 1e-9); // one heal chance per period of its own time
    if (slot === e.regenSlot) return 0;
    e.regenSlot = slot;
    if (this.won || this.lost || e.status !== 'active' || e.health >= e.maxHealth) return 0;
    const gained = round2(Math.min(e.maxHealth, e.health + REGEN_AMOUNT) - e.health);
    e.health = round2(e.health + gained);
    e.regenAt = e.steps;
    return gained;
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

  // Legacy single-explorer fields: accessors onto the primary explorer, so every existing caller and check works.
  get pos() { return this.explorers[0].pos; }
  set pos(v) { this.explorers[0].pos = v; }
  get steps() { return this.explorers[0].steps; }
  set steps(v) { this.explorers[0].steps = v; }
  get visits() { return this.explorers[0].visits; }
  set visits(v) { this.explorers[0].visits = v; }
  get trail() { return this.explorers[0].trail; }
  set trail(v) { this.explorers[0].trail = v; }
  get health() { return this.explorers[0].health; }
  set health(v) { this.explorers[0].health = v; }
  get maxHealth() { return this.explorers[0].maxHealth; }
  set maxHealth(v) { this.explorers[0].maxHealth = v; }
  get regenAt() { return this.explorers[0].regenAt; }
  set regenAt(v) { this.explorers[0].regenAt = v; }
  get graceTicks() { return this.graceLeftSteps(); }
  set graceTicks(v) { this.setGrace(null, v); }
  get facing() { return this.explorers[0].facing; }
  set facing(v) { this.explorers[0].facing = v; }
  get block() { return this.explorers[0].block; }
  set block(v) { this.explorers[0].block = v; }
  get coins() { return this.explorers[0].coins; }
  set coins(v) { this.explorers[0].coins = v; }
  get heartAt() { return this.explorers[0].heartAt; }
  set heartAt(v) { this.explorers[0].heartAt = v; }

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
      won_by: this.winBy,
      lost: this.lost,
      health: this.health,
      facing: this.facing,
      strikes: this.strikes,
      coin_piles: this.coinPiles.map((c) => [...c]),
      coins: this.coins,
      max_health: this.maxHealth,
      light: this.light.map((row) => row.slice()),
      visits: this.visits,
      trail: this.trail,
      explored_pct: this.exploredPct(),
      // Several explorers only: each one's public state (the top-level pos/health/... stay the primary's).
      ...(this.explorers.length > 1 ? { explorers: this.explorers.map((e) => ({ id: e.id, pos: [...e.pos], steps: e.steps, health: e.health, max_health: e.maxHealth, coins: e.coins, facing: e.facing, status: e.status, trail: e.trail })) } : {}),
    };
  }
}
