// Known-path progress and retreat detection (DUNGEON_DIRECTION_PLAN section 4, fog-safe form). Pure: imports
// nothing and holds no state. The brain feeds it the explorer's own numbers: `entryDistance`, the known-floor
// path length from the cell it started on (its own start: it walked there) to where it stands now, and whether
// the cell it stands on was visited before. No hidden map, room order, route or portal position is read.
// "Forward" means "further from the entry by known path", nothing more.

export const RETREAT_WINDOW = 8; // ticks the net drop in entryDistance is judged over
export const RETREAT_CELLS = 6; // net drop in entryDistance over that window that counts as a retreat
export const RETREAT_REVISITS = 6; // of the last RETREAT_WINDOW ticks, this many on already-visited ground
export const RETREAT_COOLDOWN = 20; // steps after a retreat fired (or a back-track was committed to) before it can fire again
export const RETREAT_THREAT_STEPS = 15; // a remembered sighting this young is still an active reason to be elsewhere
export const FORWARD_SLACK = 4; // a frontier is "forward" at entryDistance >= (the deepest reachable frontier's) - FORWARD_SLACK

// Appends one per-tick sample ({ d: entryDistance, revisit }) and keeps the last RETREAT_WINDOW + 1.
export function pushSample(samples, sample) {
  samples.push(sample);
  while (samples.length > RETREAT_WINDOW + 1) samples.shift();
  return samples;
}

// True when the window is full, entryDistance fell by RETREAT_CELLS or more across it, and the explorer was on
// ground it had visited before for RETREAT_REVISITS of those ticks (walking back over explored ground, not
// pushing into new ground that happens to lie closer to the entry).
export function isRetreat(samples) {
  if (samples.length < RETREAT_WINDOW + 1) return false;
  const drop = samples[0].d - samples.at(-1).d;
  const revisits = samples.slice(1).filter((s) => s.revisit).length;
  return drop >= RETREAT_CELLS && revisits >= RETREAT_REVISITS;
}

// True when the explorer is closing on its committed goal: `g` (known-path steps to the goal) fell across the window.
// Walking to a goal that lies back (everything ahead explored, or the way out of a dead-end room) is not a retreat.
export function closingOnGoal(samples) {
  if (samples.length < 2 || samples.some((s) => s.g === undefined)) return false;
  return samples[0].g - samples.at(-1).g >= 1;
}

// The forward edge among `frontier` ([{ cell, steps }]): the frontiers whose entry distance (entryOf(cell), undefined =
// unknown) is within FORWARD_SLACK of the DEEPEST REACHABLE FRONTIER's. Judged against the frontier set itself, not
// the furthest cell ever reached: a deep explored dead-end side room would otherwise push "forward" beyond every real
// edge and leave only edges near the entry. Order is kept.
export function forwardEdge(frontier, entryOf) {
  let top = -Infinity;
  for (const f of frontier) top = Math.max(top, entryOf(f.cell) ?? -Infinity);
  return frontier.filter((f) => {
    const d = entryOf(f.cell);
    return d !== undefined && d >= top - FORWARD_SLACK;
  });
}

export const FORWARD_MIN_REVEAL = 6; // an edge is a meaningful forward candidate only if lighting it would reveal this many dark cells (a 1-cell crevice ahead must not win)
export const GOAL_BEHIND_MARGIN = RETREAT_CELLS; // a kept exploration goal this far (or more) shallower than the forward edge is "behind"

// The forward band of exploration TARGET CHOICE. `frontier` = [{ cell, reveal }] (every reachable edge, reveal =
// dark cells it would light), `entryOf(cell)` = known-path distance from the explorer's own start (undefined =
// unknown). Fog-safe justification: the explorer knows from the game rules (not from any per-seed hidden state) that it
// entered at one end of the dungeon and the portal lies away from it; this reads only cells it has lit and the cell it
// started on. Returns { top, band }: `top` = the deepest meaningful edge's entry distance (-Infinity: none) and `band`
// = a Set of the edges within FORWARD_SLACK of it. Empty band = no meaningful forward edge: behave as before.
export function forwardBand(frontier, entryOf) {
  let top = -Infinity;
  for (const f of frontier) if (f.reveal >= FORWARD_MIN_REVEAL) top = Math.max(top, entryOf(f.cell) ?? -Infinity);
  const band = new Set();
  if (top === -Infinity) return { top, band };
  for (const f of frontier) if (f.reveal >= FORWARD_MIN_REVEAL && (entryOf(f.cell) ?? -Infinity) >= top - FORWARD_SLACK) band.add(f);
  return { top, band };
}
