// Coins lying around a dungeon at the start of a game. Same spread as spawnAdversaries: the count grows
// with the floor area (one per FLOOR_PER_COIN cells, at most MAX_COINS) and coins go round-robin over the
// rooms, so they spread over different rooms first. Unlike ghosts there is no distance rule: a coin near
// the start is fine. Drawn from their own PRNG stream, so dungeons, ghosts and props never change (rule 8).
// Pickup and drops live in Game.applyMove and skills/resolve.js; this file only places the opening coins.
import { isFloor, rng } from './dungeon.js';

// `export let` on purpose: src/settings.js changes these through configureCoins() (from the next game).
export let FLOOR_PER_COIN = 60;
export let MAX_COINS = 30; // 0 = no coins

export function configureCoins(o) {
  if (o.floorPerCoin !== undefined) FLOOR_PER_COIN = o.floorPerCoin;
  if (o.maxCoins !== undefined) MAX_COINS = o.maxCoins;
}

const key = ([x, y]) => `${x},${y}`;

function shuffleWith(rand, items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// dungeon -> [[x, y]] coin cells, one coin per cell. `count` overrides the floor-area formula (testbed).
// Never on the start, the chest, a small prop or a wall; at most one coin per cell.
export function spawnCoins(dungeon, { count } = {}) {
  const rand = rng((dungeon.seed ^ 0x5be0cd19) >>> 0);
  let floor = 0;
  for (const row of dungeon.tiles) for (const c of row) if (c === '.') floor++;
  const n = count ?? Math.min(MAX_COINS, Math.round(floor / FLOOR_PER_COIN));
  if (n <= 0) return [];
  const blocked = new Set([key(dungeon.start), ...(dungeon.treasure ? [key(dungeon.treasure)] : [])]);
  for (const p of dungeon.props ?? []) if (!p.solid) blocked.add(key([p.x, p.y]));
  const taken = new Set();
  const perRoom = (dungeon.rooms ?? []).map((r) => {
    const cells = [];
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        // Rooms may overlap their walls; a cell is listed once, in the first room that has it.
        if (!isFloor(dungeon, [x, y]) || blocked.has(key([x, y])) || taken.has(key([x, y]))) continue;
        taken.add(key([x, y]));
        cells.push([x, y]);
      }
    }
    return shuffleWith(rand, cells);
  }).filter((cells) => cells.length);
  shuffleWith(rand, perRoom);
  const picked = [];
  for (let round = 0; picked.length < n && perRoom.some((cells) => cells.length > round); round++) {
    for (const cells of perRoom) if (picked.length < n && cells[round]) picked.push(cells[round]);
  }
  return picked;
}
