// Pure memory helpers shared by the explorer and the adversaries (PLAN-adversary-memory.md, shared kit).
// No imports: nothing here knows about a Game, an explorer or an adversary. Each character keeps its
// own memory shape and validation; the kit only does the arithmetic on plain arrays.

// Moves in the recent window that returned to the cell two positions back (A -> B -> A). Standing
// still never counts: the position must differ from the one just left. `cells` is [[x, y], ...].
export function backAndForth(cells, moves) {
  let n = 0;
  for (let t = 0; t < moves; t++) {
    const i = cells.length - 1 - t;
    if (i < 2) break;
    const here = cells[i], one = cells[i - 1], two = cells[i - 2];
    if (here[0] === two[0] && here[1] === two[1] && (here[0] !== one[0] || here[1] !== one[1])) n++;
  }
  return n;
}

// Returns a new array: `list` plus `item`, trimmed to the newest `max`.
export function pushRing(list, item, max) {
  return [...list, item].slice(-max);
}

// Returns a new landmark list with { kind, cell, note, ...extra } added. One entry per kind + cell (a
// repeat replaces the old one and becomes the newest). Over `max`, the oldest entry whose kind is not
// `pinnedKind` is dropped (the oldest overall if all are pinned). `noteMax` caps the note text.
export function addLandmarkTo(list, entry, { max, noteMax, pinnedKind = null }) {
  const { kind, cell } = entry;
  const next = list.filter((l) => !(l.kind === kind && l.cell[0] === cell[0] && l.cell[1] === cell[1]));
  next.push({ ...entry, cell: [...cell], note: String(entry.note).trim().slice(0, noteMax) });
  while (next.length > max) {
    const i = next.findIndex((l) => l.kind !== pinnedKind);
    next.splice(i === -1 ? 0 : i, 1);
  }
  return next;
}

// Keeps entries younger than `ttl` (age = now - entry[field]); `pinned(entry)` entries never expire.
export function ageEntries(list, now, ttl, { field = 'tick', pinned = () => false } = {}) {
  return list.filter((e) => pinned(e) || now - e[field] <= ttl);
}
