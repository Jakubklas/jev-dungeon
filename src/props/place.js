// Prop placement: wall decor first, then solid props, then small props (CONTRACT.md, v4).
// Self-contained and DOM-free; does not import dungeon.js (that would be an import cycle).
import {
  KINDS, SOLID_KINDS, SINGLE_SOLID_KINDS, SMALL_KINDS, BIG_DECOR_KINDS,
  TORCH_MIN, TORCH_MAX, TORCH_GAP, BIG_MIN_RUN, BIG_CHANCE, CORRIDOR_TORCH_PER_ROOM, CORRIDOR_TORCH_GAP,
  CLUSTER_SIZE_MIN, CLUSTER_SIZE_MAX, CLUSTER_PER_CELLS, CLUSTER_MAX, CLUSTER_GAP, CLUSTER_TRIES, TREASURE_FRACTION, MIN_EXITS,
  SMALL_PER_CELLS, SMALL_MAX, CORRIDOR_SMALL_PER_CELLS,
  FOOTPRINT_STANDIN, FORGE_SHAPES, FORGE_ROOM_CHANCE, FORGE_MIN_INNER, FORGE_MIN_AREA,
} from './catalog.js';

// `dungeon` needs width, height, tiles (strings), rooms, start, treasure. `rand` is () => [0,1).
// Returns the new tiles (solid prop cells become '#'), props and decor, each sorted by y then x.
export function placeProps(dungeon, rand) {
  const { width: W, height: H, rooms, start, treasure } = dungeon;
  const N = W * H;
  const at = (x, y) => y * W + x;
  const inB = (x, y) => x >= 0 && x < W && y >= 0 && y < H;
  const floor0 = new Uint8Array(N); // original floor
  const open = new Uint8Array(N); // floor now (solid props closed)
  const roomAt = new Int16Array(N).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (dungeon.tiles[y][x] === '.') floor0[at(x, y)] = open[at(x, y)] = 1;
  rooms.forEach((r, i) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) roomAt[at(x, y)] = i;
  });
  const wall0 = (x, y) => inB(x, y) && !floor0[at(x, y)];
  const isOpen = (x, y) => inB(x, y) && open[at(x, y)] === 1;
  const NB = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const sIdx = at(start[0], start[1]), tIdx = at(treasure[0], treasure[1]);
  const nearCell = (x, y, c) => Math.abs(x - c[0]) + Math.abs(y - c[1]) <= 1;

  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const pickKind = (kinds) => {
    let t = rand() * kinds.reduce((s, k) => s + KINDS[k].weight, 0);
    for (const k of kinds) if ((t -= KINDS[k].weight) < 0) return k;
    return kinds[kinds.length - 1];
  };

  // 1. Wall decor. decorAt marks wall cells, front marks the floor cell each item faces.
  const decor = [];
  const decorAt = new Uint8Array(N);
  const front = new Uint8Array(N);
  const decorNear = (x, y, gap) => {
    for (let dy = -gap + 1; dy <= gap - 1; dy++) {
      for (let dx = -gap + 1; dx <= gap - 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) < gap && inB(x + dx, y + dy) && decorAt[at(x + dx, y + dy)]) return true;
      }
    }
    return false;
  };
  const addDecor = (kind, x, y, face) => {
    decor.push({ kind, x, y, face });
    decorAt[at(x, y)] = 1;
    front[face === 'L' ? at(x, y + 1) : at(x + 1, y)] = 1;
  };
  // Wall cells of a room whose face touches the room: top wall faces L, left wall faces R.
  const roomWalls = (r) => {
    const out = [];
    for (let x = r.x; x < r.x + r.w; x++) if (wall0(x, r.y - 1)) out.push([x, r.y - 1, 'L']);
    for (let y = r.y; y < r.y + r.h; y++) if (wall0(r.x - 1, y)) out.push([r.x - 1, y, 'R']);
    return out;
  };
  for (const r of rooms) {
    if ((r.w >= BIG_MIN_RUN || r.h >= BIG_MIN_RUN) && rand() < BIG_CHANCE) {
      const runs = [];
      if (r.w >= BIG_MIN_RUN) {
        for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
          if (wall0(x - 1, r.y - 1) && wall0(x, r.y - 1) && wall0(x + 1, r.y - 1)) runs.push([x, r.y - 1, 'L']);
        }
      }
      if (r.h >= BIG_MIN_RUN) {
        for (let y = r.y + 1; y < r.y + r.h - 1; y++) {
          if (wall0(r.x - 1, y - 1) && wall0(r.x - 1, y) && wall0(r.x - 1, y + 1)) runs.push([r.x - 1, y, 'R']);
        }
      }
      const free = runs.filter(([x, y]) => !decorNear(x, y, 2));
      if (free.length) {
        const [x, y, face] = free[Math.floor(rand() * free.length)];
        addDecor(pickKind(BIG_DECOR_KINDS), x, y, face);
      }
    }
    const walls = shuffle(roomWalls(r));
    const want = TORCH_MIN + Math.floor(rand() * (TORCH_MAX - TORCH_MIN + 1));
    let placed = 0;
    for (const gap of [TORCH_GAP, 2]) { // second pass only if the room got none
      for (const [x, y, face] of walls) {
        if (placed >= want || (gap === 2 && placed >= TORCH_MIN)) break;
        if (!decorAt[at(x, y)] && !decorNear(x, y, gap)) { addDecor('torch', x, y, face); placed++; }
      }
    }
  }
  // Occasional corridor torches: wall cells facing a corridor (floor outside every room rect).
  const corr = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (floor0[at(x, y)]) continue;
      if (floor0[at(x, y + 1)] && roomAt[at(x, y + 1)] < 0) corr.push([x, y, 'L']);
      if (floor0[at(x + 1, y)] && roomAt[at(x + 1, y)] < 0) corr.push([x, y, 'R']);
    }
  }
  shuffle(corr);
  const wantCorr = Math.floor(rooms.length * CORRIDOR_TORCH_PER_ROOM + rand());
  for (let i = 0, placed = 0; i < corr.length && placed < wantCorr; i++) {
    const [x, y, face] = corr[i];
    if (!decorAt[at(x, y)] && !decorNear(x, y, CORRIDOR_TORCH_GAP)) { addDecor('torch', x, y, face); placed++; }
  }

  // 2. Solid props. Doorways: room floor cells touching floor outside their room rect.
  const doorNear = new Uint8Array(N); // doorway cells and their 4-neighbours
  rooms.forEach((r, i) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (!floor0[at(x, y)] || !NB.some(([dx, dy]) => floor0[at(x + dx, y + dy)] && roomAt[at(x + dx, y + dy)] !== i)) continue;
        doorNear[at(x, y)] = 1;
        for (const [dx, dy] of NB) if (inB(x + dx, y + dy)) doorNear[at(x + dx, y + dy)] = 1;
      }
    }
  });
  const dist = new Int32Array(N);
  const queue = new Int32Array(N);
  // Floor reachable from start, farthest distance, and the treasure's distance (-1 = unreachable).
  const survey = () => {
    dist.fill(-1);
    let head = 0, tail = 0;
    dist[sIdx] = 0;
    queue[tail++] = sIdx;
    while (head < tail) {
      const i = queue[head++], d = dist[i] + 1, x = i % W;
      if (open[i - W] && dist[i - W] < 0) { dist[i - W] = d; queue[tail++] = i - W; }
      if (open[i + W] && dist[i + W] < 0) { dist[i + W] = d; queue[tail++] = i + W; }
      if (x > 0 && open[i - 1] && dist[i - 1] < 0) { dist[i - 1] = d; queue[tail++] = i - 1; }
      if (x < W - 1 && open[i + 1] && dist[i + 1] < 0) { dist[i + 1] = d; queue[tail++] = i + 1; }
    }
    return { count: tail, far: dist[queue[tail - 1]], treasure: dist[tIdx] };
  };
  let floorLeft = 0;
  for (let i = 0; i < N; i++) floorLeft += open[i];
  // Every open cell of room r reachable from every other without leaving the rect (no split rooms).
  const roomConnected = (r) => {
    let first = -1, total = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) if (open[at(x, y)]) { total++; if (first < 0) first = at(x, y); }
    }
    if (first < 0) return true;
    const seen = new Set([first]);
    const q = [first];
    for (let h = 0; h < q.length; h++) {
      const x = q[h] % W, y = (q[h] - x) / W;
      for (const [dx, dy] of NB) {
        const nx = x + dx, ny = y + dy, j = at(nx, ny);
        if (nx >= r.x && nx < r.x + r.w && ny >= r.y && ny < r.y + r.h && open[j] && !seen.has(j)) { seen.add(j); q.push(j); }
      }
    }
    return seen.size === total;
  };
  // Clusters stand off the room's edge ring, so a walkable lane always runs behind them (cover,
  // not flush corner fill), and keep CLUSTER_GAP from each other so they never merge.
  const nearSolid = new Uint8Array(N); // cells within CLUSTER_GAP-1 (Chebyshev) of a placed solid
  const nearStartOrTreasure = (x, y) => [start, treasure].some((c) => Math.abs(x - c[0]) <= 1 && Math.abs(y - c[1]) <= 1);
  // Close `cells` of room r if that keeps the map sound (no dead-end pockets, room still in one piece, every
  // floor cell still reachable, chest still far enough); otherwise reopen them. `surveyed`: the full BFS ran.
  const closeCells = (cells, r) => {
    for (const [x, y] of cells) open[at(x, y)] = 0;
    // No dead-end pockets: each floor neighbour keeps MIN_EXITS floor neighbours.
    let good = cells.every(([x, y]) => NB.every(([dx, dy]) => !isOpen(x + dx, y + dy) ||
      NB.reduce((n, [ex, ey]) => n + (isOpen(x + dx + ex, y + dy + ey) ? 1 : 0), 0) >= MIN_EXITS));
    if (good) good = roomConnected(r);
    const surveyed = good;
    if (good) {
      const s = survey();
      good = s.count === floorLeft - cells.length && s.treasure >= TREASURE_FRACTION * s.far;
    }
    if (!good) { for (const [x, y] of cells) open[at(x, y)] = 1; return { good, surveyed }; }
    floorLeft -= cells.length;
    for (const [x, y] of cells) {
      for (let dy = 1 - CLUSTER_GAP; dy < CLUSTER_GAP; dy++) {
        for (let dx = 1 - CLUSTER_GAP; dx < CLUSTER_GAP; dx++) if (inB(x + dx, y + dy)) nearSolid[at(x + dx, y + dy)] = 1;
      }
    }
    return { good, surveyed };
  };
  const props = [];
  const roomClusters = new Int16Array(rooms.length); // clusters placed per room
  for (const [ri, r] of rooms.entries()) {
    const inner = (x, y) => x > r.x && x < r.x + r.w - 1 && y > r.y && y < r.y + r.h - 1;
    const ok = (x, y) => {
      const i = at(x, y);
      return inner(x, y) && open[i] && !front[i] && !doorNear[i] && !nearSolid[i] && !nearStartOrTreasure(x, y);
    };
    const innerArea = Math.max(0, r.w - 2) * Math.max(0, r.h - 2);
    const target = Math.min(CLUSTER_MAX, Math.floor(innerArea / CLUSTER_PER_CELLS + rand()));
    if (!target) continue;
    const cands = [];
    for (let y = r.y + 1; y < r.y + r.h - 1; y++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) if (ok(x, y)) cands.push([x, y]);
    shuffle(cands);
    let placed = 0, tries = 0;
    for (const [sx, sy] of cands) {
      if (placed >= target || tries >= CLUSTER_TRIES) break;
      if (!ok(sx, sy)) continue;
      // Grow a 4-connected cluster of a random size; it stays smaller if the room runs out of space.
      const size = CLUSTER_SIZE_MIN + Math.floor(rand() * (CLUSTER_SIZE_MAX - CLUSTER_SIZE_MIN + 1));
      const cells = [[sx, sy]];
      const inCluster = (x, y) => cells.some(([cx, cy]) => cx === x && cy === y);
      while (cells.length < size) {
        const grow = [];
        for (const [cx, cy] of cells) {
          for (const [dx, dy] of NB) {
            const nx = cx + dx, ny = cy + dy;
            if (ok(nx, ny) && !inCluster(nx, ny) && !grow.some(([gx, gy]) => gx === nx && gy === ny)) grow.push([nx, ny]);
          }
        }
        if (!grow.length) break;
        cells.push(grow[Math.floor(rand() * grow.length)]);
      }
      const res = closeCells(cells, r);
      if (res.surveyed) tries++;
      if (!res.good) continue;
      placed++;
      roomClusters[ri]++;
      // One facing per cluster: a row along x backs onto y-1 (flip:false), a column along y onto x-1.
      const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
      const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
      const flip = spanX === spanY ? rand() < 0.5 : spanY > spanX;
      const multiKinds = SOLID_KINDS.filter((k) => !SINGLE_SOLID_KINDS.includes(k));
      for (const [x, y] of cells) {
        const kind = pickKind(cells.length === 1 ? SOLID_KINDS : multiKinds);
        props.push({ kind: KINDS[kind].footprint ? FOOTPRINT_STANDIN : kind, x, y, solid: true, flip });
      }
    }
  }

  // 3. Small props: walkable and cosmetic, in rooms and (rarely) corridors.
  const taken = new Uint8Array(N);
  const smallOk = (x, y) => {
    const i = at(x, y);
    return open[i] && !taken[i] && i !== sIdx && i !== tIdx && !nearCell(x, y, treasure);
  };
  const addSmall = ([x, y]) => {
    taken[at(x, y)] = 1;
    props.push({ kind: pickKind(SMALL_KINDS), x, y, solid: false, flip: rand() < 0.5 });
  };
  for (const r of rooms) {
    const cells = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (smallOk(x, y)) cells.push([x, y]);
    shuffle(cells);
    const n = Math.min(SMALL_MAX, Math.floor(r.w * r.h / SMALL_PER_CELLS + rand()), cells.length);
    for (let k = 0; k < n; k++) addSmall(cells[k]);
  }
  const lanes = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (roomAt[at(x, y)] < 0 && smallOk(x, y)) lanes.push([x, y]);
  shuffle(lanes);
  const nLane = Math.min(Math.floor(lanes.length / CORRIDOR_SMALL_PER_CELLS + rand()), lanes.length);
  for (let k = 0; k < nLane; k++) addSmall(lanes[k]);

  // 4. Forges, last: they take only what is still free (no small prop under them), draw nothing from `rand`
  // (their own stream is keyed on the room's geometry), so every other prop is exactly where it would be without them.
  rooms.forEach((r, ri) => {
    const innerW = r.w - 2, innerH = r.h - 2;
    if (innerW < FORGE_MIN_INNER || innerH < FORGE_MIN_INNER || innerW * innerH < FORGE_MIN_AREA || roomClusters[ri] >= CLUSTER_MAX) return;
    let h = Math.imul(r.x * 73856093 ^ r.y * 19349663 ^ r.w * 83492791 ^ r.h * 2654435761 ^ (start[0] * 31 + start[1]) * 40503 ^ W * 7919, 2246822519) >>> 0;
    const own = () => { // mulberry32
      h = (h + 0x6d2b79f5) >>> 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    if (own() >= FORGE_ROOM_CHANCE) return;
    const ok = (x, y) => {
      const i = at(x, y);
      return x > r.x && x < r.x + r.w - 1 && y > r.y && y < r.y + r.h - 1 && open[i] && !front[i] && !doorNear[i] && !nearSolid[i] &&
        !taken[i] && !nearStartOrTreasure(x, y);
    };
    const [fw, fh] = FORGE_SHAPES[Math.floor(own() * FORGE_SHAPES.length)];
    const flip = own() < 0.5;
    const spots = [];
    for (let y = r.y + 1; y + fh <= r.y + r.h - 1; y++) {
      for (let x = r.x + 1; x + fw <= r.x + r.w - 1; x++) {
        let all = true;
        for (let dy = 0; dy < fh && all; dy++) for (let dx = 0; dx < fw && all; dx++) all = ok(x + dx, y + dy);
        if (all) spots.push([x, y]);
      }
    }
    for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(own() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
    for (const [x0, y0] of spots.slice(0, CLUSTER_TRIES)) {
      const cells = [];
      for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) cells.push([x0 + dx, y0 + dy]);
      if (!closeCells(cells, r).good) continue;
      // The anchor (top-left cell, min x then min y) carries the footprint size; the other cells are parts.
      for (const [x, y] of cells) props.push({ kind: 'forge', x, y, solid: true, flip, ...(x === x0 && y === y0 ? { w: fw, h: fh } : { part: true }) });
      break;
    }
  });

  const byPos = (a, b) => a.y - b.y || a.x - b.x;
  props.sort(byPos);
  decor.sort(byPos);
  const tiles = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) row += open[at(x, y)] ? '.' : '#';
    tiles.push(row);
  }
  return { tiles, props, decor };
}
