// Hearts lying around a dungeon at the start of a game: rare, fixed, one per ROOMS_PER_HEART rooms (at least one when
// there are rooms to hold it, at most MAX_HEARTS). A heart restores one life when stepped on while hurt (Game.applyMove).
// Same spread as spawnCoins on its own PRNG stream, so dungeons, ghosts, props and coins never change (rule 8).
import { isFloor, rng } from './dungeon.js';

// `export let` on purpose: src/settings.js changes these through configureHearts() (from the next game).
export let ROOMS_PER_HEART = 4;
export let MAX_HEARTS = 6; // 0 = no hearts

export function configureHearts(o) {
  if (o.roomsPerHeart !== undefined) ROOMS_PER_HEART = o.roomsPerHeart;
  if (o.maxHearts !== undefined) MAX_HEARTS = o.maxHearts;
}

const key = ([x, y]) => `${x},${y}`;

// dungeon -> [[x, y]] heart cells, one per cell, each in a different room, never on the start, the chest, a small prop or a coin.
export function spawnHearts(dungeon, { count } = {}) {
  const rand = rng((dungeon.seed ^ 0x2f6b1d57) >>> 0);
  const rooms = dungeon.rooms ?? [];
  const n = Math.min(rooms.length, count ?? (MAX_HEARTS <= 0 ? 0 : Math.min(MAX_HEARTS, Math.max(1, Math.round(rooms.length / ROOMS_PER_HEART)))));
  if (n <= 0) return [];
  const blocked = new Set([key(dungeon.start), ...(dungeon.treasure ? [key(dungeon.treasure)] : []), ...(dungeon.coins ?? []).map(key)]);
  for (const p of dungeon.props ?? []) if (!p.solid) blocked.add(key([p.x, p.y]));
  const order = rooms.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  // Linear layout: side rooms first (a detour that pays), then the rest, each group in shuffled order.
  if (dungeon.layout?.kind === 'linear') order.sort((a, b) => (rooms[a].role === 'side' ? 0 : 1) - (rooms[b].role === 'side' ? 0 : 1));
  const picked = [];
  for (const i of order) {
    if (picked.length >= n) break;
    const r = rooms[i], cells = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (isFloor(dungeon, [x, y]) && !blocked.has(key([x, y]))) cells.push([x, y]);
    if (cells.length) picked.push(cells[Math.floor(rand() * cells.length)]);
  }
  return picked;
}
