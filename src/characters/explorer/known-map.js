// Pure helpers over the explorer's KnownWorld, shared by the encounter model (encounter.js) and
// exploration/perception (perception.js): cell arithmetic, known-floor BFS, frontier, reveal
// estimate and compass words. FOG OF WAR: every map read goes through world.isKnown/knownTile,
// so unknown cells are neither wall nor floor and paths only run over known floor. This file
// imports no other explorer file, which keeps known-map <- encounter <- perception acyclic.

import { DIRS, LIGHT_RADIUS } from '../../dungeon.js';

export const key = ([x, y]) => `${x},${y}`;
export const sameCell = (a, b) => a[0] === b[0] && a[1] === b[1];
export const step = ([x, y], dir) => [x + DIRS[dir][0], y + DIRS[dir][1]];
export const neighbours = (c) => Object.keys(DIRS).map((d) => step(c, d));
export const knownFloor = (world, c) => world.knownTile(c) === '.';
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Known floor that touches at least one unknown cell: the edge of the known map.
export function isFrontier(world, c) {
  return knownFloor(world, c) && neighbours(c).some((n) => !world.isKnown(n));
}

// Step counts over known floor only, optionally with one cell blocked off.
// Flat Int32Array (index y * width + x, -1 = not reached) plus the visiting order.
// Known floor is always inside the map, so the index never wraps.
// `admit(cell, steps)` (optional) rejects cells that may not be entered at that step count;
// `endCell` may be entered regardless but is not expanded (the portal: stepping on it ends the game).
// A seen portal is impassable and never reached unless `endCell` is it or `allowPortal` is set: only the
// leaving approaches (go_to_exit, race_to_exit) may route through it, so no other target or route can
// win by accident.
export function knownDistances(world, from, blocked = null, admit = null, endCell = null, allowPortal = false) {
  const W = world.width;
  const dist = new Int32Array(W * world.height).fill(-1);
  const order = [];
  const at = (c) => c[1] * W + c[0];
  const result = {
    get: (c) => {
      if (c[0] < 0 || c[0] >= W || c[1] < 0 || c[1] >= world.height) return undefined;
      const d = dist[at(c)];
      return d < 0 ? undefined : d;
    },
    has: (c) => result.get(c) !== undefined,
    // Reached cells in fixed (y, x) order, so tie-breaks never depend on where the BFS started.
    cells: () => order.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]),
    order,
  };
  dist[at(from)] = 0;
  order.push(from);
  const blockedIdx = blocked ? at(blocked) : -1;
  const endIdx = endCell ? at(endCell) : -1;
  const portal = allowPortal ? null : world.seenTreasure();
  const portalIdx = portal ? at(portal) : -1;
  for (let i = 0; i < order.length; i++) {
    const d = dist[at(order[i])] + 1;
    for (const n of neighbours(order[i])) {
      if (!knownFloor(world, n)) continue;
      const ni = at(n);
      if (dist[ni] >= 0 || ni === blockedIdx || (ni === portalIdx && ni !== endIdx)) continue;
      if (ni === endIdx) { dist[ni] = d; continue; }
      if (admit && !admit(n, d)) continue;
      dist[ni] = d;
      order.push(n);
    }
  }
  return result;
}

// Unknown cells that a visit to `c` would light up. Light needs no line of sight,
// so this counts unknown space without peeking at what it holds.
export function wouldReveal(world, [cx, cy], radius = LIGHT_RADIUS) {
  let n = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (Math.hypot(x - cx, y - cy) <= radius && !world.isKnown([x, y])) n++;
    }
  }
  return n;
}

// Compass name for the direction from `a` to `b` (y points down, so north is smaller y).
export function compass([ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'east' : 'west';
  return dy >= 0 ? 'south' : 'north';
}

// A move as a compass word (y points down): what Jev reads in `recent.path`.
const DIR_WORD = { up: 'north', down: 'south', left: 'west', right: 'east' };
export const dirWord = (dir) => DIR_WORD[dir] ?? dir;

const COMPASS8 = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
export function compass8([ax, ay], [bx, by]) {
  const angle = Math.atan2(ay - by, bx - ax); // y points down, so flip it
  return COMPASS8[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
}

// Reachable frontier cells with their step counts, in a fixed (y, x) order.
export function reachableFrontier(world, dist) {
  return dist.cells()
    .filter((c) => isFrontier(world, c))
    .map((c) => ({ cell: c, steps: dist.get(c) }));
}

// Picks the best entry: highest score first, then fewest steps, then fixed cell order.
export function pick(list, score) {
  let best = null;
  for (const f of list) {
    const s = score(f);
    if (!best || s > best.s || (s === best.s && f.steps < best.f.steps)) best = { f, s };
  }
  return best?.f ?? null;
}
