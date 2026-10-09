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
export let REGEN_STEPS = 30; // the explorer heals REGEN_AMOUNT lives every this many steps (0 = never)
export let REGEN_AMOUNT = 0.5; // lives healed per regen (health may be fractional: 1.5 of 2)
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
  if (o.regenAmount !== undefined) REGEN_AMOUNT = o.regenAmount;
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
// distortions (organic rooms, winding corridors 1-4 wide) can never add a shortcut. A failed attempt is retried
// with weaker distortion; the last attempt (plain rectangles, straight 1-wide corridors) always succeeds.
const LINEAR_ATTEMPTS = 12;
const SPINE_SHARE = 0.6; // share of the patch grid the main path covers
const SPINE_BUDGET = 6000; // search nodes for the self-avoiding walk

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
  const rooms = [], patches = [], cores = [];
  for (const node of nodes) {
    const p = patchOf(node.cell);
    const big = node.role === 'portal';
    // Rooms fill well under their patch, so the corridors between them have room to wind; the portal room is bigger.
    const lo = (side) => Math.max(3, Math.min(side, big ? Math.ceil(side * 0.65) : Math.max(ROOM_MIN, Math.ceil(side * 0.4))));
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
  }

  // 5. Corridors: a walk with momentum and side-steps between two room cores, painted with a brush whose width
  // drifts 1..4, kept inside the rectangle made of the two patches and the strip between them (no other patch).
  for (const [a, b] of links) {
    const pa = patches[a], pb = patches[b];
    // Narrow patches get narrower corridors, or the corridors swallow the rooms.
    const maxW = Math.max(1, Math.min(1 + Math.round(3 * strength), Math.floor(Math.min(pa.w, pa.h, pb.w, pb.h) / 3)));
    const R = { x0: Math.min(pa.x, pb.x), y0: Math.min(pa.y, pb.y), x1: Math.max(pa.x + pa.w, pb.x + pb.w) - 1, y1: Math.max(pa.y + pa.h, pb.y + pb.h) - 1 };
    const inR = (x, y) => x >= R.x0 && x <= R.x1 && y >= R.y0 && y <= R.y1;
    let [x, y] = cores[a];
    const [qx, qy] = cores[b];
    let w = strength > 0 ? int(1, maxW) : 1;
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
        // Side-step across the current heading.
        const s = rand() < 0.5 ? -1 : 1;
        if (axis === 0 && inR(x, y + s)) y += s;
        else if (axis === 1 && inR(x + s, y)) x += s;
      } else {
        if ((axis === 0 && !dx) || (axis === 1 && !dy) || (strength > 0 && rand() < 0.2)) axis = dx && (!dy || rand() < Math.abs(dx) / (Math.abs(dx) + Math.abs(dy))) ? 0 : 1;
        if (axis === 0 && dx) x += Math.sign(dx);
        else if (axis === 1 && dy) y += Math.sign(dy);
        else if (dx) x += Math.sign(dx);
        else y += Math.sign(dy);
      }
      if (strength > 0 && rand() < 0.15) w = Math.max(1, Math.min(maxW, w + (rand() < 0.5 ? -1 : 1)));
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
          if (!spawnable && d >= SPAWN_STEPS && !(Math.hypot(x - start[0], y - start[1]) <= SIGHT_RANGE &&
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
    this.regenAt = null; // the step of the last regen heal (Run.playTurn turns it into a `regen` event)
    this.graceTicks = 0; // ticks of hit protection left (adversary.js GRACE_TICKS counts it down)
    this.trail = [[...dungeon.start]];
    this.adversaries = [];
    this.adversaryTicks = 0; // world ticks the adversaries have run (adversary.js)
    this.patrolRand = null; // per-game patrol RNG, created on the first patrol goal (adversary.js)
    this.facing = 'right'; // the explorer's 4-way facing: last step's direction or last strike's aim
    this.block = null; // the explorer's shield stance: null | { effectiveness, until_step }
    this.strikes = []; // strikes this tick: { by, cells, result } (src/skills/resolve.js)
    this.dispelled = []; // monsters dispelled this tick: { id, at } (resolve.js); the death cry reads it (monster morale)
    this.skillRand = null; // seeded block-roll stream, created on the first roll (skillRandom)
    this.coinPiles = (dungeon.coins ?? []).map((c) => [...c]); // coins on the floor, one [x, y] per coin (duplicates = a bigger pile); replaced, never spliced. Opening coins: src/coins.js
    this.coins = 0; // the explorer's total
    this.heartPiles = (dungeon.hearts ?? []).map((c) => [...c]); // floating hearts: stepping on one restores a life (applyMove); replaced, never spliced. Testbed `hearts` option only
    this.winBy = null; // how the game was won: 'chest' (applyMove) or 'cleared' (the last adversary dispelled, resolve.js)
    this.coinRand = null; // seeded coin-drop stream, created on the first roll (coinRandom)
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
    this.health = Math.max(0, round2(this.health - amount));
    if (this.health === 0) {
      this.lost = true;
      this.caughtBy = sourceId;
    }
    return { health: this.health, lost: this.lost };
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

  // Start-of-tick cleanup for skill state: strikes are per tick, a block lapses once steps passes until_step.
  clearTickState() {
    this.strikes = [];
    this.dispelled = [];
    if (this.block && this.steps > this.block.until_step) this.block = null;
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
      const regen = this.regenerate();
      return { moved: false, stayed: true, revealed: 0, revisit: false, won: this.won, regen };
    }
    if (this.won || this.lost || !this.legalMoves().includes(dir)) {
      return { moved: false, revealed: 0, revisit: false, won: this.won };
    }
    const next = [this.pos[0] + DIRS[dir][0], this.pos[1] + DIRS[dir][1]];
    const k = key(next);
    const revisit = (this.visits[k] ?? 0) > 0;
    this.visits[k] = (this.visits[k] ?? 0) + 1;
    this.pos = next;
    this.facing = dir;
    this.steps++;
    this.trail.push([...next]);
    const revealed = lightAround(this, next);
    const here = this.coinPiles.filter((c) => same(c, next)).length;
    if (here) {
      this.coinPiles = this.coinPiles.filter((c) => !same(c, next)); // replace: twin() shares the old array
      this.coins += here;
    }
    let healed = 0;
    if (this.health < this.maxHealth && this.heartPiles.some((c) => same(c, next))) { // a heart is only used up when it heals
      this.heartPiles = this.heartPiles.filter((c) => !same(c, next));
      healed = round2(Math.min(this.maxHealth, this.health + 1) - this.health); // a fractional health never goes above max
      this.health = round2(this.health + healed);
    }
    const regen = this.regenerate();
    this.won = !!this.dungeon.treasure && same(next, this.dungeon.treasure); // testbed arenas may have no chest
    if (this.won) this.winBy = 'chest';
    return { moved: true, revealed, revisit, won: this.won, coins: here, healed, regen };
  }

  // Slow natural healing: every REGEN_STEPS steps a hurt, living explorer gets REGEN_AMOUNT lives back, up to max.
  // Called by applyMove after the step is counted (a stay counts too). Returns the lives healed (0 if none).
  regenerate() {
    if (!REGEN_STEPS || !REGEN_AMOUNT || this.steps % REGEN_STEPS !== 0) return 0;
    if (this.won || this.lost || this.health >= this.maxHealth) return 0;
    const gained = round2(Math.min(this.maxHealth, this.health + REGEN_AMOUNT) - this.health);
    this.health = round2(this.health + gained);
    this.regenAt = this.steps;
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
    };
  }
}
