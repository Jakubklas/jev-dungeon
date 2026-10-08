// Prop catalog: kinds, classes, weights and placement constants. DOM-free, no imports.
// Ids are fixed by CONTRACT.md (v4); place.js and the art/renderer files key on them.

// cls: 'solid' (blocks the cell, drawn as floor, '#' in tiles, placed in clusters), 'small' (walkable, cosmetic),
// 'decor' (on a wall face). big: needs a straight wall run, at most one per room.
export const KINDS = {
  shelf: { cls: 'solid', solid: true, weight: 3 },
  crates: { cls: 'solid', solid: true, weight: 3 },
  storage_chest: { cls: 'solid', solid: true, weight: 2 },
  // single: only picked for one-cell clusters (keeps multi-cell clusters, and so existing layouts, as they were)
  fountain: { cls: 'solid', solid: true, single: true, weight: 1 }, // blue water, glows
  // forge: the big furnace. Never part of a random cluster (single keeps it out of the multi-cell pools); it is
  // placed by place.js as one footprint of FORGE_SHAPES cells (4-6), or listed in the testbed with w/h. Glows.
  forge: { cls: 'solid', solid: true, single: true, footprint: true, weight: 1 },
  pots: { cls: 'small', solid: false, weight: 3 },
  skull: { cls: 'small', solid: false, weight: 2 },
  tools: { cls: 'small', solid: false, weight: 2 },
  sword: { cls: 'small', solid: false, weight: 1 },
  anvil: { cls: 'small', solid: false, weight: 1 },
  goblet: { cls: 'small', solid: false, weight: 1 }, // blue-flame brazier, glows
  torch: { cls: 'decor', weight: 1 },
  fireplace: { cls: 'decor', big: true, weight: 3 },
  arch: { cls: 'decor', big: true, weight: 2 },
  gate: { cls: 'decor', big: true, weight: 2 },
  banner: { cls: 'decor', big: true, weight: 2 },
};

const ids = (cls) => Object.keys(KINDS).filter((k) => KINDS[k].cls === cls);
export const SOLID_KINDS = ids('solid');
export const SINGLE_SOLID_KINDS = SOLID_KINDS.filter((k) => KINDS[k].single);
export const FOOTPRINT_KINDS = SOLID_KINDS.filter((k) => KINDS[k].footprint);
// Where a footprint kind would be picked as a one-cell prop (random testbed arenas, ASCII 'p', the generator's
// one-cell clusters) a plain crate stands instead. The pick itself is unchanged, so no rng() count moves.
export const FOOTPRINT_STANDIN = 'crates';
export const SMALL_KINDS = ids('small');
export const BIG_DECOR_KINDS = Object.keys(KINDS).filter((k) => KINDS[k].big);

// Wall decor
export let TORCH_MIN = 1; // torches per room
export let TORCH_MAX = 3;
export let TORCH_GAP = 3; // preferred Manhattan gap between decor items (4-adjacent is never allowed)
export let BIG_MIN_RUN = 6; // room cells along the wall for fireplace / arch / gate
export let BIG_CHANCE = 0.5; // chance a room that is long enough gets one
export let CORRIDOR_TORCH_PER_ROOM = 0.4; // expected corridor torches per room
export let CORRIDOR_TORCH_GAP = 5;

// Solid props: free-standing clusters of 1-4 cells inside rooms, so the explorer can duck behind them.
export let CLUSTER_SIZE_MIN = 1;
export let CLUSTER_SIZE_MAX = 4;
export let CLUSTER_PER_CELLS = 30; // about one cluster per this many inner room cells (room minus its edge ring)
export let CLUSTER_MAX = 3; // clusters per room
export let CLUSTER_GAP = 2; // min Chebyshev distance between cells of different clusters (one free cell between)
export let CLUSTER_TRIES = 25; // full-BFS attempts per room
export let TREASURE_FRACTION = 0.6; // treasure keeps this share of the farthest path distance
export let MIN_EXITS = 2; // every floor neighbour of a solid prop keeps this many floor neighbours

// Forge: one furnace over a connected block of solid cells, w (x) by h (y). Placed after every other prop, on its
// own deterministic stream, so no other prop moves. At most one per room, never more than CLUSTER_MAX clusters in it.
export const FORGE_SHAPES = [[2, 2], [2, 3], [3, 2]]; // [w, h]: 4 or 6 cells
export let FORGE_ROOM_CHANCE = 0.12; // chance a big enough room gets one
export let FORGE_MIN_INNER = 4; // room cells inside the edge ring, each way (needs lanes around it)
export let FORGE_MIN_AREA = 20; // inner cells

// Small props
export let SMALL_PER_CELLS = 25; // about one per this many room cells
export let SMALL_MAX = 3; // per room
export let CORRIDOR_SMALL_PER_CELLS = 150; // about one per this many corridor cells

// Settings hook (src/config/runtime.js). Placement reads these when a dungeon is generated, so changes apply to the
// next game; a kind weight of 0 keeps that kind out of the random picks (explicit testbed props can still name it).
export function configureProps(o) {
  const set = {
    torchMin: (v) => { TORCH_MIN = v; }, torchMax: (v) => { TORCH_MAX = v; }, torchGap: (v) => { TORCH_GAP = v; },
    corridorTorchPerRoom: (v) => { CORRIDOR_TORCH_PER_ROOM = v; }, corridorTorchGap: (v) => { CORRIDOR_TORCH_GAP = v; },
    bigMinRun: (v) => { BIG_MIN_RUN = v; }, bigChance: (v) => { BIG_CHANCE = v; },
    clusterSizeMin: (v) => { CLUSTER_SIZE_MIN = v; }, clusterSizeMax: (v) => { CLUSTER_SIZE_MAX = v; }, clusterPerCells: (v) => { CLUSTER_PER_CELLS = v; },
    clusterMax: (v) => { CLUSTER_MAX = v; }, clusterGap: (v) => { CLUSTER_GAP = v; }, clusterTries: (v) => { CLUSTER_TRIES = v; },
    treasureShare: (v) => { TREASURE_FRACTION = v; }, minExits: (v) => { MIN_EXITS = v; },
    forgeRoomChance: (v) => { FORGE_ROOM_CHANCE = v; }, forgeMinInner: (v) => { FORGE_MIN_INNER = v; }, forgeMinArea: (v) => { FORGE_MIN_AREA = v; },
    smallPerCells: (v) => { SMALL_PER_CELLS = v; }, smallMax: (v) => { SMALL_MAX = v; }, corridorSmallPerCells: (v) => { CORRIDOR_SMALL_PER_CELLS = v; },
  };
  for (const [k, fn] of Object.entries(set)) if (o[k] !== undefined) fn(o[k]);
  for (const id of Object.keys(KINDS)) if (o[`propWeight_${id}`] !== undefined) KINDS[id].weight = o[`propWeight_${id}`];
}
