// Prop catalog: kinds, classes, weights and placement constants. DOM-free, no imports.
// Ids are fixed by CONTRACT.md (v4); place.js and the art/renderer files key on them.

// cls: 'solid' (blocks the cell, drawn as floor, '#' in tiles, placed in clusters), 'small' (walkable, cosmetic),
// 'decor' (on a wall face). big: needs a straight wall run, at most one per room.
export const KINDS = {
  shelf: { cls: 'solid', solid: true, weight: 3 },
  crates: { cls: 'solid', solid: true, weight: 3 },
  storage_chest: { cls: 'solid', solid: true, weight: 2 },
  pots: { cls: 'small', solid: false, weight: 3 },
  skull: { cls: 'small', solid: false, weight: 2 },
  tools: { cls: 'small', solid: false, weight: 2 },
  sword: { cls: 'small', solid: false, weight: 1 },
  torch: { cls: 'decor', weight: 1 },
  fireplace: { cls: 'decor', big: true, weight: 3 },
  arch: { cls: 'decor', big: true, weight: 2 },
  gate: { cls: 'decor', big: true, weight: 2 },
};

const ids = (cls) => Object.keys(KINDS).filter((k) => KINDS[k].cls === cls);
export const SOLID_KINDS = ids('solid');
export const SMALL_KINDS = ids('small');
export const BIG_DECOR_KINDS = Object.keys(KINDS).filter((k) => KINDS[k].big);

// Wall decor
export const TORCH_MIN = 1; // torches per room
export const TORCH_MAX = 3;
export const TORCH_GAP = 3; // preferred Manhattan gap between decor items (4-adjacent is never allowed)
export const BIG_MIN_RUN = 6; // room cells along the wall for fireplace / arch / gate
export const BIG_CHANCE = 0.5; // chance a room that is long enough gets one
export const CORRIDOR_TORCH_PER_ROOM = 0.4; // expected corridor torches per room
export const CORRIDOR_TORCH_GAP = 5;

// Solid props: free-standing clusters of 1-4 cells inside rooms, so the explorer can duck behind them.
export const CLUSTER_SIZE_MIN = 1;
export const CLUSTER_SIZE_MAX = 4;
export const CLUSTER_PER_CELLS = 30; // about one cluster per this many inner room cells (room minus its edge ring)
export const CLUSTER_MAX = 3; // clusters per room
export const CLUSTER_GAP = 2; // min Chebyshev distance between cells of different clusters (one free cell between)
export const CLUSTER_TRIES = 25; // full-BFS attempts per room
export const TREASURE_FRACTION = 0.6; // treasure keeps this share of the farthest path distance
export const MIN_EXITS = 2; // every floor neighbour of a solid prop keeps this many floor neighbours

// Small props
export const SMALL_PER_CELLS = 25; // about one per this many room cells
export const SMALL_MAX = 3; // per room
export const CORRIDOR_SMALL_PER_CELLS = 150; // about one per this many corridor cells
