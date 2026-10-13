// AdversaryView: one ghost's window on a Game, the adversary-side twin of the explorer's KnownWorld.
// It is the only adversary file (with adversary.js, which owns the physics) that may hold a Game or
// touch dungeon.tiles; perception.js, brain.js and memory.js take a `view`, never a `game`
// (static guard in check-dungeon.mjs section 0).
//
// Mode `full` (A1): the ghost reads the real map, exactly as before, so the requests Jev sees are
// byte-identical. Mode `limited` (A4, the limitedMap toggle): the ghost knows a set K of floor cells,
// the union of its home zone H (spawn-room plus everything within homeRadius path steps of its spawn
// cell, computed once in the constructor: the single geometry read of the real map), the cells it has
// seen (line of sight, stamped, fading after the character's seenTtl, capped at seenCap) and the cells a
// call copied from a packmate's own K. The 4 cells around it are always known (it bumps into walls).
// A wall is known iff it is 8-adjacent to a known floor cell, so the tiles next to K may be read and
// nothing else. BFS, view, kinds and teammates are all derived from K.
//
// Every read is live (never cached across ticks). Never exposed: the treasure, the explorer's
// light/visits/health, real tiles. The explorer's position and heading come out only while this
// ghost has it in sight (hunt.inSight, set by brain.js from seesExplorer / team sight).
import { DIRS, SIGHT_RANGE, floorDistances, hasLineOfSight, isFloor } from '../../dungeon.js';

const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const stepCell = ([x, y], dir) => [x + DIRS[dir][0], y + DIRS[dir][1]];
const key = ([x, y]) => `${x},${y}`;
const cellOf = (k) => k.split(',').map(Number);
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
let HEARD_STEPS = 6; // path steps around a reported cell that a call copies from the caller's map

export class AdversaryView {
  #game;
  #a;
  #limited;
  #home = null; // Set of "x,y": the home zone H (limited mode)
  #seen = new Map(); // "x,y" -> tick stamp: seen cells S plus heard cells T, oldest stamp first
  #inView = []; // [x, y] cells in view from #viewAt (real line of sight), limited mode
  #viewAt = null;
  #forgotten = 0; // cells that faded or were evicted so far
  mode;

  constructor(game, adversary, { limited = false } = {}) {
    this.#game = game;
    this.#a = adversary;
    this.#limited = limited;
    this.mode = limited ? 'limited' : 'full';
    if (limited) this.#buildHome();
  }

  // H: floor cells whose real path distance from the spawn cell is within homeRadius (null = the whole
  // map), plus the whole spawn room. Read once, never expires.
  #buildHome() {
    const d = this.#game.dungeon;
    const radius = this.#a.profile.homeRadius;
    this.#home = new Set();
    for (const [k, steps] of floorDistances(d, this.#a.home)) if (radius === null || steps <= radius) this.#home.add(k);
    const [hx, hy] = this.#a.home;
    const room = (d.rooms ?? []).find((r) => hx >= r.x && hx < r.x + r.w && hy >= r.y && hy < r.y + r.h);
    if (room) {
      for (let y = room.y; y < room.y + room.h; y++) for (let x = room.x; x < room.x + room.w; x++) if (isFloor(d, [x, y])) this.#home.add(key([x, y]));
    }
  }

  get pos() {
    return this.#a.pos;
  }

  get tick() {
    return this.#game.monsterTick();
  }

  // The explorer's cell while this ghost has it in sight, else null.
  explorer() {
    return this.#a.hunt.inSight ? [...this.#game.targetExplorer(this.#a.pos).pos] : null;
  }

  // Direction of the explorer's latest move, read only while it is in sight.
  heading() {
    if (!this.#a.hunt.inSight) return null;
    const t = this.#game.targetExplorer(this.#a.pos).trail ?? [];
    if (t.length < 2) return null;
    const [p, q] = t.slice(-2);
    const dx = q[0] - p[0], dy = q[1] - p[1];
    return Object.keys(DIRS).find((d) => DIRS[d][0] === dx && DIRS[d][1] === dy) ?? null;
  }

  // Is the explorer's sword a threat right now? It carries the sword openly, so a ghost that has the explorer in
  // sight knows it; the cooldown itself is not visible (and the default cooldown is one turn), so in sight = armed.
  explorerArmed() {
    return this.#a.hunt.inSight;
  }

  // Can a ghost standing on `cell` see the explorer? Only asked while it is in sight. In limited mode
  // an unknown cell on the line blocks, like the explorer's knownLineOfSight.
  seesExplorerFrom(cell) {
    const e = this.explorer();
    if (!e || euclid(cell, e) > SIGHT_RANGE) return false;
    return this.#limited ? this.#knownLos(cell, e, e) : hasLineOfSight(this.#game.dungeon, cell, e);
  }

  // Packmates this ghost knows about: in full mode every one (id, position, role are shared on purpose);
  // in limited mode only those it can hear (known-map path within its alert reach) or see. Never their
  // private state, except the freshest sighting each has called out.
  teammates() {
    const others = (this.#game.adversaries ?? []).filter((o) => o.id !== this.#a.id);
    const list = this.#limited ? this.#heardOnly(others) : others;
    return list.map((o) => ({ id: o.id, pos: o.pos, role: o.hunt.on ? (o.hunt.inSight ? 'pursuing' : 'searching') : 'patrolling', sighting: o.memory.sightings[0] ?? null }));
  }

  // How many packmates exist (a count, never where they are).
  teammateCount() {
    return (this.#game.adversaries ?? []).filter((o) => o.id !== this.#a.id).length;
  }

  #heardOnly(others) {
    const reach = this.#a.profile.alertSteps;
    const fromMe = this.distancesFrom(this.pos);
    const inView = new Set(this.cellsInView().map(key));
    return others.filter((o) => {
      const d = fromMe.get(key(o.pos));
      return (d !== undefined && d <= reach) || inView.has(key(o.pos));
    });
  }

  isKnown(cell) {
    const d = this.#game.dungeon;
    if (!this.#limited) return isFloor(d, cell);
    const k = key(cell);
    if (this.#home.has(k) || this.#seen.has(k)) return true;
    const [px, py] = this.pos;
    return Math.abs(cell[0] - px) + Math.abs(cell[1] - py) <= 1 && isFloor(d, cell); // the cells around it are always known
  }

  // A wall is known iff it is 8-adjacent to a known floor cell (limited mode; in full mode every wall).
  isKnownWall(cell) {
    const d = this.#game.dungeon;
    if (isFloor(d, cell)) return false;
    if (!this.#limited) return true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && this.isKnown([cell[0] + dx, cell[1] + dy])) return true;
    return false;
  }

  neighbours(cell) {
    return Object.keys(DIRS).map((d) => stepCell(cell, d)).filter((n) => this.isKnown(n));
  }

  legalMoves() {
    return Object.keys(DIRS).filter((d) => this.isKnown(stepCell(this.pos, d)));
  }

  // Path distances (Map of "x,y" -> steps) from `cell` over the cells this ghost knows. A cell outside
  // the known set reaches nothing (empty map); callers read a missing entry as "no known route".
  distancesFrom(cell) {
    if (!this.#limited) return floorDistances(this.#game.dungeon, cell);
    const out = new Map();
    if (!this.isKnown(cell)) return out;
    out.set(key(cell), 0);
    const queue = [cell];
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      const d = out.get(key(c));
      for (const dir of Object.keys(DIRS)) {
        const n = stepCell(c, dir);
        const k = key(n);
        if (!out.has(k) && this.isKnown(n)) {
          out.set(k, d + 1);
          queue.push(n);
        }
      }
    }
    return out;
  }

  // Floor cells seen from `from` (default: here), same sight rule as seesExplorer. Limited mode: from
  // here this is the real line-of-sight physics and it stamps what it sees into the known set; from any
  // other cell (a move's destination) only known cells count, through known cells.
  cellsInView(from = this.pos) {
    const d = this.#game.dungeon;
    if (!this.#limited) {
      const out = [];
      const R = SIGHT_RANGE;
      for (let y = from[1] - R; y <= from[1] + R; y++) {
        for (let x = from[0] - R; x <= from[0] + R; x++) {
          const c = [x, y];
          if (euclid(from, c) <= R && this.isKnown(c) && hasLineOfSight(d, from, c)) out.push(c);
        }
      }
      return out;
    }
    if (same(from, this.pos)) {
      this.#scan();
      this.#stamp(this.tick);
      return this.#inView.map((c) => [...c]);
    }
    const out = [];
    const R = SIGHT_RANGE;
    for (let y = from[1] - R; y <= from[1] + R; y++) {
      for (let x = from[0] - R; x <= from[0] + R; x++) {
        const c = [x, y];
        if (euclid(from, c) <= R && this.isKnown(c) && this.#knownLos(from, c)) out.push(c);
      }
    }
    return out;
  }

  // Start of a world tick (adversary.js calls it for every ghost in id order, before anyone senses or
  // decides): stamps what this ghost sees from where it stands, then lets old cells fade.
  update(tick = this.tick) {
    if (!this.#limited) return;
    this.#scan();
    this.#stamp(tick);
  }

  // A call: copy the caller's known floor cells within HEARD_STEPS path steps of the reported cell into
  // this ghost's map (from the caller's K, never from the real map), stamped now.
  hear(caller, cell, tick = this.tick) {
    if (!this.#limited || !caller.#limited) return;
    this.#put(key(cell), tick);
    for (const [k, steps] of caller.distancesFrom(cell)) if (steps <= HEARD_STEPS) this.#put(k, tick);
    this.#trim(tick);
  }

  // The known frontier cell nearest (Euclid) to a target outside the map, among the cells reachable
  // from here over K: a known floor cell next to a floor cell it does not know. { cell, steps } | null.
  frontierToward(target, dist = this.distancesFrom(this.pos)) {
    let best = null;
    for (const [k, steps] of dist) {
      const c = cellOf(k);
      if (!this.#isFrontier(c)) continue;
      const e = euclid(c, target);
      if (!best || e < best.e || (e === best.e && (steps < best.steps || (steps === best.steps && (c[1] < best.cell[1] || (c[1] === best.cell[1] && c[0] < best.cell[0])))))) best = { cell: c, steps, e };
    }
    return best && { cell: best.cell, steps: best.steps };
  }

  #isFrontier(c) {
    const d = this.#game.dungeon;
    return Object.keys(DIRS).some((dir) => {
      const n = stepCell(c, dir);
      return !this.isKnown(n) && isFloor(d, n);
    });
  }

  // Known floor cells: the home zone plus what is currently remembered.
  knownCount() {
    if (!this.#limited) return null;
    let n = this.#home.size;
    for (const k of this.#seen.keys()) if (!this.#home.has(k)) n++;
    return n;
  }

  // For the checks and measurements: sorted known floor keys, how many cells faded or were evicted.
  knownKeys() {
    if (!this.#limited) return null;
    return [...new Set([...this.#home, ...this.#seen.keys()])].sort();
  }

  get forgotten() {
    return this.#forgotten;
  }

  // What kind of place a cell is: room, doorway, junction, corridor or dead end, plus its exit count.
  // Only known cells have a kind (their neighbours' tiles are known too: 8-adjacent to K).
  kindOf(cell) {
    const d = this.#game.dungeon;
    if (this.#limited && !this.isKnown(cell)) return { kind: 'unknown', exits: 0 };
    const inRoom = ([x, y]) => (d.rooms ?? []).some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    const exits = Object.keys(DIRS).map((dir) => stepCell(cell, dir)).filter((n) => isFloor(d, n));
    if (inRoom(cell)) return { kind: 'room', exits: exits.length };
    if (exits.some((n) => inRoom(n))) return { kind: 'doorway', exits: exits.length };
    if (exits.length >= 3) return { kind: 'junction', exits: exits.length };
    return { kind: exits.length === 2 ? 'corridor' : 'dead end', exits: exits.length };
  }

  // --- limited mode internals ---------------------------------------------------------------

  // Real line-of-sight physics from where the ghost stands (cached per cell: the map never changes).
  #scan() {
    const k = key(this.pos);
    if (this.#viewAt === k) return;
    this.#viewAt = k;
    const d = this.#game.dungeon;
    const from = this.pos;
    const R = SIGHT_RANGE;
    const out = [];
    for (let y = from[1] - R; y <= from[1] + R; y++) {
      for (let x = from[0] - R; x <= from[0] + R; x++) {
        const c = [x, y];
        if (euclid(from, c) <= R && isFloor(d, c) && hasLineOfSight(d, from, c)) out.push(c);
      }
    }
    this.#inView = out;
  }

  #put(k, tick) {
    if (this.#home.has(k)) return;
    this.#seen.delete(k); // re-insert so the map stays ordered by latest stamp
    this.#seen.set(k, tick);
  }

  #stamp(tick) {
    for (const c of this.#inView) this.#put(key(c), tick);
    this.#trim(tick);
  }

  // Fading and the cap: the oldest stamps go first.
  #trim(tick) {
    const { seenTtl, seenCap } = this.#a.profile;
    for (const [k, t] of this.#seen) {
      if (tick - t > seenTtl || this.#seen.size > seenCap) {
        this.#seen.delete(k);
        this.#forgotten++;
      } else break;
    }
  }

  // Supercover line of sight over K: an unknown cell blocks. `extra` is one more cell to treat as known.
  #knownLos(a, b, extra = null) {
    if (a[1] > b[1] || (a[1] === b[1] && a[0] > b[0])) [a, b] = [b, a];
    const wall = (c) => !(this.isKnown(c) || (extra && same(c, extra)));
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const nx = Math.abs(dx), ny = Math.abs(dy);
    const sx = Math.sign(dx), sy = Math.sign(dy);
    let x = a[0], y = a[1];
    for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
      const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
      if (decision === 0) {
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
}

// Central config hook (src/config/runtime.js): the constants above are `let` so a changed value is seen at once.
export function configureAdversaryView(o) {
  if (o.advHeardSteps !== undefined) HEARD_STEPS = o.advHeardSteps;
}
// The values in force, keyed like the registry (the config check compares them with the registry defaults).
export const adversaryViewSnapshot = () => ({ advHeardSteps: HEARD_STEPS });
