// Route (spectator navigation): the shortest walkable path from the start to the portal (the "spine"), how far
// along it the explorer is, whether it is advancing / exploring / backtracking, and a gentle cue when it keeps
// heading for the entrance. Built AFTER generation from the finished tiles and the treasure cell (no rng, the
// layout never changes). SPECTATOR-ONLY: it reads hidden data, so it goes into Run.view() for the browser and
// nowhere else. Nothing under src/characters/explorer/ may import it, and no Jev request may carry any of it.
// Progress is WALKING distance along the spine (never straight-line), so two corridors on either side of a wall
// cannot swap progress, and a side room keeps its junction's progress with an offset above zero.

import { DIRS, floorDistances } from './dungeon.js';
import { seesExplorer } from './characters/adversary/adversary.js';

const WINDOW_TICKS = 8; // progress samples kept (one per tick); direction is newest minus oldest
const DEADBAND_CELLS = 3; // a net change smaller than this is "not moving" (stay, jitter, a corner)
const DETOUR_OFFSET = 3; // walking cells off the spine beyond which the explorer is exploring a side pocket
const BACKTRACK_ENTER = 5; // net cells toward the entrance that start a retreat ...
const BACKTRACK_EXIT = 2; // ... and net cells forward that end it (hysteresis)
const CUE_BEHIND = 6; // cells behind its furthest point before the cue may show
const CUE_COOLDOWN = 25; // ticks between two cues
const COMBAT_HOLD = 3; // a hit / strike this many ticks ago still holds the cue back
const LOOKAHEAD = 6; // steps ahead the next waypoint points
const CUE_TEXT = 'Heading toward the entrance — portal is the other way.';
const DETOUR_APPROACHES = new Set(['heal', 'collect_coins']); // a deliberate trip for a heart / coins
const COMBAT_EVENTS = new Set(['hit', 'bump', 'strike', 'struck', 'blocked', 'dispelled']);

const NAMES = ['up', 'down', 'left', 'right']; // DIRS order: every neighbour loop here uses it, so ties are deterministic
const NEIGHBOURS = NAMES.map((name) => ({ name, dx: DIRS[name][0], dy: DIRS[name][1] }));
const round3 = (n) => Math.round(n * 1000) / 1000;

// null without a treasure (testbed) or when the portal cannot be reached from the start. Otherwise a frozen
// { width, height, start, treasure, length, spine, waypoints, attach, offset, toPortal }; the three typed
// arrays are indexed y * width + x (-1 on walls / unreachable cells).
export function buildRoute(dungeon) {
  const { width, height, start, treasure } = dungeon;
  if (!treasure || !start) return null;
  const dist = floorDistances(dungeon, treasure);
  if (!dist.has(`${start[0]},${start[1]}`)) return null;
  const size = width * height;
  const toPortal = new Int32Array(size).fill(-1);
  for (const [k, d] of dist) {
    const c = k.indexOf(',');
    toPortal[Number(k.slice(c + 1)) * width + Number(k.slice(0, c))] = d;
  }
  // The spine: from the start, always step to a neighbour one closer to the portal.
  const spine = [[start[0], start[1]]];
  let [x, y] = start;
  while (toPortal[y * width + x] > 0) {
    const want = toPortal[y * width + x] - 1;
    const next = NEIGHBOURS.find((n) => x + n.dx >= 0 && x + n.dx < width && y + n.dy >= 0 && y + n.dy < height && toPortal[(y + n.dy) * width + x + n.dx] === want);
    x += next.dx;
    y += next.dy;
    spine.push([x, y]);
  }
  // Corner cells plus both ends, for the debug overlay.
  if (spine.length < 2) return null; // start on the portal: nothing to navigate
  const waypoints = [spine[0]];
  for (let i = 1; i < spine.length - 1; i++) {
    const a = spine[i - 1], b = spine[i], c = spine[i + 1];
    if (b[0] - a[0] !== c[0] - b[0] || b[1] - a[1] !== c[1] - b[1]) waypoints.push(b);
  }
  waypoints.push(spine[spine.length - 1]);
  // Every floor cell's nearest spine cell BY WALKING: a multi-source BFS seeded in spine order, so a tie goes to
  // the lowest index (each cell takes its attach from the first neighbour that reaches it).
  const attach = new Int32Array(size).fill(-1);
  const offset = new Int32Array(size).fill(-1);
  const queue = new Int32Array(size);
  let head = 0, tail = 0;
  spine.forEach(([sx, sy], i) => { const j = sy * width + sx; attach[j] = i; offset[j] = 0; queue[tail++] = j; });
  while (head < tail) {
    const i = queue[head++];
    const cx = i % width, cy = (i / width) | 0;
    for (const n of NEIGHBOURS) {
      const nx = cx + n.dx, ny = cy + n.dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const j = ny * width + nx;
      if (toPortal[j] < 0 || attach[j] >= 0) continue;
      attach[j] = attach[i];
      offset[j] = offset[i] + 1;
      queue[tail++] = j;
    }
  }
  return Object.freeze({
    width, height, start: [...start], treasure: [...treasure], length: spine.length - 1,
    spine: Object.freeze(spine), waypoints: Object.freeze(waypoints), attach, offset, toPortal,
  });
}

// One tracker per Run. update() once per tick, after the adversaries have moved; snapshot() is the
// view().route object.
export class RouteTracker {
  #route;
  #samples = []; // the last WINDOW_TICKS spine indices
  #last = null; // previous cell, to spot a move that is not a 4-neighbour step
  #ticks = 0;
  #state = 'stationary';
  #furthest = 0;
  #cueOn = false;
  #shownThisRetreat = false; // re-armed only by advancing
  #lastCueTick = -Infinity;
  #lastCombatTick = -Infinity;
  #view = null;

  constructor(route) {
    this.#route = route;
  }

  update(game, { events = [], approach = null, directive = null } = {}) {
    const r = this.#route;
    this.#ticks++;
    const [x, y] = game.pos;
    const i = y * r.width + x;
    const distance = r.attach[i];
    if (distance < 0) return; // not on reachable floor: keep the last reading
    if (events.some((e) => COMBAT_EVENTS.has(e.type))) this.#lastCombatTick = this.#ticks;
    // The explorer moves one cell a tick, but a jump of any kind must not read as a sprint along the route.
    if (this.#last && Math.abs(x - this.#last[0]) + Math.abs(y - this.#last[1]) > 1) this.#samples.length = 0;
    this.#last = [x, y];
    this.#samples.push(distance);
    if (this.#samples.length > WINDOW_TICKS) this.#samples.shift();
    const off = r.offset[i];

    const state = this.#classify(off);
    this.#state = state;
    if (state === 'advancing') this.#shownThisRetreat = false;
    if (distance > this.#furthest) this.#furthest = distance;
    if (state !== 'backtracking') this.#cueOn = false;
    const suppressed = this.#suppression(game, approach, directive);
    if (state === 'backtracking' && !this.#cueOn && !this.#shownThisRetreat && !suppressed &&
        this.#furthest - distance >= CUE_BEHIND && this.#ticks - this.#lastCueTick >= CUE_COOLDOWN) {
      this.#cueOn = true;
      this.#shownThisRetreat = true;
      this.#lastCueTick = this.#ticks;
    }

    // Next waypoint: follow strictly decreasing toPortal, LOOKAHEAD steps (always walkable, and it turns at the
    // corridor opening instead of aiming through a wall).
    let cx = x, cy = y, dir = null;
    for (let s = 0; s < LOOKAHEAD && r.toPortal[cy * r.width + cx] > 0; s++) {
      const want = r.toPortal[cy * r.width + cx] - 1;
      const n = NEIGHBOURS.find((m) => cx + m.dx >= 0 && cx + m.dx < r.width && cy + m.dy >= 0 && cy + m.dy < r.height && r.toPortal[(cy + m.dy) * r.width + cx + m.dx] === want);
      if (!n) break;
      if (dir === null) dir = n.name;
      cx += n.dx;
      cy += n.dy;
    }
    this.#view = {
      progress: round3(distance / r.length),
      furthest: round3(this.#furthest / r.length),
      distance,
      length: r.length,
      offset: off,
      state,
      next_waypoint: dir === null ? null : [cx, cy],
      next_dir: dir,
      cue: this.#cueOn && !suppressed ? CUE_TEXT : null,
      suppressed,
      waypoints: r.waypoints,
    };
  }

  // The view().route object (a copy: callers may serialise or edit it).
  snapshot() {
    const v = this.#view;
    return v && { ...v, next_waypoint: v.next_waypoint && [...v.next_waypoint] };
  }

  #classify(off) {
    const s = this.#samples, n = s.length;
    if (off > DETOUR_OFFSET) return 'exploring';
    const net = s[n - 1] - s[0];
    if (this.#state === 'backtracking' && net < BACKTRACK_EXIT) {
      // A retreat ends on a clear step forward; a full window confined to a few cells (stopped, jittering) ends it too.
      return n >= WINDOW_TICKS && Math.max(...s) - Math.min(...s) < DEADBAND_CELLS ? 'stationary' : 'backtracking';
    }
    if (net >= DEADBAND_CELLS) return 'advancing';
    if (net <= -BACKTRACK_ENTER) return 'backtracking';
    // Inside the deadband: keep "advancing" only while the last two steps both still moved forward.
    if (this.#state === 'advancing' && n >= 3 && s[n - 1] > s[n - 2] && s[n - 2] > s[n - 3]) return 'advancing';
    return 'stationary';
  }

  // Why a cue would be held back right now, in priority order: the game is over, the portal is already lit (its
  // own cue wins), combat (a chasing ghost sees the explorer, or a combat event within COMBAT_HOLD ticks), or a
  // deliberate detour (the explorer is healing or collecting coins, or the player gave a directive).
  #suppression(game, approach, directive) {
    if (game.won || game.lost) return 'over';
    if (game.isKnown(this.#route.treasure)) return 'portal_known';
    if (this.#ticks - this.#lastCombatTick <= COMBAT_HOLD || (game.adversaries ?? []).some((a) => a.mode === 'chase' && seesExplorer(game, a))) return 'combat';
    if (DETOUR_APPROACHES.has(approach) || directive) return 'detour';
    return null;
  }
}
