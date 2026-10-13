// Checks for src/route.js (spectator navigation spine, progress, direction state, cue). Pure world-side:
// over linear and maze seeds plus testbed arenas: the spine is walkable, contiguous, deterministic and does not
// touch the layout; progress is monotone along it, never jumps across a wall; side rooms read as exploring;
// a retreat from the middle is flagged (once) well before the entrance; stay / jitter never are; combat and a
// known portal hold the cue back; the next step is always walkable; the view contract; timings.
// Run from the dungeon-game directory: node scripts/check-route.mjs [seeds]. Free, no Jev (fetch tripwire).

process.env.JEV_CONFIG = 'none';
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const world = await import('../src/dungeon.js'); // namespace: MIN_SIZE / MAX_SIZE / LAYOUT are live bindings
const { generateDungeon, configureWorld, floorDistances, Game } = world;
const { buildRoute, RouteTracker } = await import('../src/route.js');
const { newGame, newTestGame } = await import('../src/turn.js');

const SEEDS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 40;
let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures <= 30) console.error('FAIL:', msg);
};
const key = ([x, y]) => `${x},${y}`;

const startLayout = world.LAYOUT, startMin = world.MIN_SIZE, startMax = world.MAX_SIZE;
const restore = () => configureWorld({ layout: startLayout, minSize: startMin, maxSize: startMax });

function newTracker(d) {
  const route = buildRoute(d);
  const game = new Game(d);
  game.adversaries = [];
  const tracker = new RouteTracker(route);
  let events = [];
  const at = (cell, ev = []) => { game.pos = [...cell]; game.steps++; tracker.update(game, { events: ev }); return tracker.snapshot(); };
  at(d.start);
  return { route, game, tracker, at };
}

// Walk the cells in order, returning every snapshot.
function walk(t, cells) {
  return cells.map((c) => t.at(c));
}

function checkSpine(d, label) {
  const route = buildRoute(d);
  if (!route) return fail(`${label}: no route on a dungeon with a reachable portal`);
  const { spine, width } = route;
  if (key(spine[0]) !== key(d.start)) fail(`${label}: spine does not start at the start`);
  if (key(spine[spine.length - 1]) !== key(d.treasure)) fail(`${label}: spine does not end at the portal`);
  if (route.length !== spine.length - 1) fail(`${label}: length is not spine.length - 1`);
  const dist = floorDistances(d, d.start).get(key(d.treasure));
  if (dist !== route.length) fail(`${label}: spine length ${route.length} is not the shortest path ${dist}`);
  for (let i = 0; i < spine.length; i++) {
    const [x, y] = spine[i];
    if (d.tiles[y][x] !== '.') fail(`${label}: spine cell ${i} (${x},${y}) is not floor`);
    if (i && Math.abs(x - spine[i - 1][0]) + Math.abs(y - spine[i - 1][1]) !== 1) fail(`${label}: spine breaks at ${i}`);
    if (route.attach[y * width + x] !== i || route.offset[y * width + x] !== 0) fail(`${label}: spine cell ${i} does not attach to itself`);
  }
  // Every floor cell has an attach and an offset; walls have none.
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      const i = y * width + x, floor = d.tiles[y][x] === '.';
      if (floor !== (route.attach[i] >= 0) || floor !== (route.offset[i] >= 0)) { fail(`${label}: attach/offset coverage wrong at ${x},${y}`); y = d.height; break; }
    }
  }
  const again = buildRoute(d);
  if (JSON.stringify(again.spine) !== JSON.stringify(spine) || again.attach.join() !== route.attach.join()) fail(`${label}: route is not deterministic`);
  if (!Object.isFrozen(route)) fail(`${label}: route is not frozen`);
  if (route.waypoints[0] !== spine[0] && key(route.waypoints[0]) !== key(spine[0])) fail(`${label}: waypoints must start at the start`);
  if (key(route.waypoints.at(-1)) !== key(spine.at(-1))) fail(`${label}: waypoints must end at the portal`);
  return route;
}

let totalFar = 0;
// ---- 1. spine, determinism, layout untouched (linear and maze) ----
for (const layout of ['linear', 'maze']) {
  configureWorld({ layout });
  const n = layout === 'linear' ? SEEDS : 6;
  for (let seed = 1; seed <= n; seed++) {
    const label = `${layout} seed ${seed}`;
    const before = generateDungeon(seed);
    const snapshot = JSON.stringify(before);
    const route = checkSpine(before, label);
    if (JSON.stringify(before) !== snapshot) fail(`${label}: buildRoute mutated the dungeon`);
    if (JSON.stringify(generateDungeon(seed)) !== snapshot) fail(`${label}: generation differs after building a route`);
    if (!route) continue;

    // ---- 2. walking the spine: monotone progress and 'advancing' once the window fills ----
    const t = newTracker(before);
    const snaps = walk(t, route.spine.slice(1));
    snaps.forEach((s, i) => {
      if (s.distance !== i + 1) fail(`${label}: distance ${s.distance} at spine index ${i + 1}`);
      if (i && s.progress < snaps[i - 1].progress) fail(`${label}: progress went down walking forward at ${i + 1}`);
      if (i >= 8 && s.state !== 'advancing') fail(`${label}: state ${s.state} (not advancing) at spine index ${i + 1}`);
      if (s.offset !== 0) fail(`${label}: offset ${s.offset} on the spine`);
      if (s.cue) fail(`${label}: cue while advancing`);
    });
    if (snaps.at(-1).progress !== 1) fail(`${label}: progress at the portal is ${snaps.at(-1).progress}`);
    if (snaps.at(-1).next_dir !== null || snaps.at(-1).next_waypoint !== null) fail(`${label}: next step on the portal should be null`);

    // ---- 3. wall-adjacent pairs: attach follows WALKING distance (triangle bounds), never jumps ----
    let farPairs = 0;
    const floors = [];
    for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) if (before.tiles[y][x] === '.') floors.push([x, y]);
    const step = Math.max(1, Math.floor(floors.length / 25));
    for (let f = seed % step; f < floors.length; f += step) {
      const p = floors[f];
      const dist = floorDistances(before, p);
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const q = [p[0] + dx, p[1] + dy];
        if (before.tiles[q[1]]?.[q[0]] !== '.') continue;
        const w = dist.get(key(q));
        const ip = p[1] * before.width + p[0], iq = q[1] * before.width + q[0];
        const da = Math.abs(route.attach[ip] - route.attach[iq]);
        const slack = route.offset[ip] + route.offset[iq];
        if (da > w + slack) fail(`${label}: attach jumps ${da} between ${key(p)} and ${key(q)} only ${w} apart on foot`);
        if (da < w - slack) fail(`${label}: attach ${da} apart but ${w} apart on foot (${key(p)}, ${key(q)})`);
        if (w >= 12 && Math.abs(dx) + Math.abs(dy) <= 2) farPairs++;
      }
    }
    // Every floor pair within 2 cells whose walking distance is at least 10 more (toPortal differs: a lower bound
    // on the walk): their progress must differ by about that much, minus how far each sits off the spine.
    for (const p of floors) {
      for (const [dx, dy] of [[2, 0], [0, 2], [1, 1], [-1, 1]]) {
        const q = [p[0] + dx, p[1] + dy];
        if (before.tiles[q[1]]?.[q[0]] !== '.') continue;
        const ip = p[1] * before.width + p[0], iq = q[1] * before.width + q[0];
        const gap = Math.abs(route.toPortal[ip] - route.toPortal[iq]);
        if (gap < 10) continue;
        farPairs++;
        const da = Math.abs(route.attach[ip] - route.attach[iq]);
        if (da < gap - route.offset[ip] - route.offset[iq]) fail(`${label}: nearby ${key(p)} and ${key(q)} are ${gap}+ apart on foot but only ${da} apart on the spine`);
      }
    }
    totalFar += farPairs;
    if (seed <= 3) console.log(`${label}: spine ${route.length} cells, ${route.waypoints.length} waypoints, ${farPairs} wall-adjacent far pairs`);

    // ---- 4. side rooms (linear): the junction's progress, offset above zero, exploring, no cue ----
    if (layout === 'linear') {
      for (const room of before.rooms.filter((r) => r.role === 'side').slice(0, 3)) {
        let deepest = null;
        for (let y = room.y; y < room.y + room.h; y++) {
          for (let x = room.x; x < room.x + room.w; x++) {
            const i = y * before.width + x;
            if (route.offset[i] <= 0) continue; // a wall corner of the rect, or a path corridor crossing it
            if (!deepest || route.offset[i] > route.offset[deepest[1] * before.width + deepest[0]]) deepest = [x, y];
          }
        }
        if (!deepest) continue;
        // From the deepest cell follow shrinking offset to the spine (a parent chain), then play it in and out.
        const out = [deepest];
        for (let c = deepest; route.offset[c[1] * before.width + c[0]] > 0;) {
          const o = route.offset[c[1] * before.width + c[0]];
          c = [[0, -1], [0, 1], [-1, 0], [1, 0]].map(([dx, dy]) => [c[0] + dx, c[1] + dy])
            .find(([x, y]) => route.offset[y * before.width + x] === o - 1 && route.attach[y * before.width + x] === route.attach[c[1] * before.width + c[0]]);
          out.push(c);
        }
        const junction = route.attach[deepest[1] * before.width + deepest[0]];
        const tt = newTracker(before);
        const states = [];
        walk(tt, route.spine.slice(1, junction + 1)).forEach((s) => states.push(s));
        for (const s of walk(tt, [...out].reverse())) states.push(s);
        for (const s of walk(tt, out.slice(1))) states.push(s);
        for (const s of walk(tt, [...out].reverse().slice(1))) states.push(s);
        if (states.some((s) => s.state === 'backtracking')) fail(`${label}: side room trip read as backtracking`);
        if (states.some((s) => s.cue)) fail(`${label}: side room trip showed a cue`);
        const deep = states.find((s) => s.offset > 3);
        if (route.offset[deepest[1] * before.width + deepest[0]] > 3 && (!deep || deep.state !== 'exploring')) fail(`${label}: deep in a side room is not 'exploring'`);
      }
    }

    // ---- 5. retreat from the middle: flagged early, once; then stay and jitter are never flagged ----
    {
      const mid = Math.floor(route.length / 2);
      const tt = newTracker(before);
      walk(tt, route.spine.slice(1, mid + 1));
      const back = walk(tt, route.spine.slice(0, mid).reverse());
      const first = back.findIndex((s) => s.cue);
      const cues = back.filter((s, i) => s.cue && !(i && back[i - 1].cue)).length;
      if (first < 0) fail(`${label}: no cue on a retreat from the middle`);
      else {
        const atCue = back[first].distance;
        if (atCue < 0.1 * mid) fail(`${label}: cue came too late (distance ${atCue} of ${mid})`);
        if (back[first].state !== 'backtracking') fail(`${label}: cue without backtracking`);
      }
      if (cues > 1) fail(`${label}: ${cues} cue episodes in one retreat`);
      if (!back.some((s) => s.state === 'backtracking')) fail(`${label}: retreat never read as backtracking`);
      // Turning round clears the cue as soon as the state leaves backtracking.
      const forward = walk(tt, route.spine.slice(Math.max(1, mid - 12), mid + 1));
      if (forward.at(-1).cue) fail(`${label}: cue still up after walking forward again`);

      const stay = newTracker(before);
      const at = route.spine[mid];
      walk(stay, route.spine.slice(1, mid + 1));
      const seen = [];
      for (let k = 0; k < 20; k++) seen.push(stay.at(at));
      if (seen.some((s) => s.state === 'backtracking' || s.cue)) fail(`${label}: standing still read as a retreat`);
      if (seen.at(-1).state !== 'stationary') fail(`${label}: standing still is ${seen.at(-1).state}`);
      for (const startAt of [0, mid]) {
        const jit = newTracker(before);
        if (startAt) walk(jit, route.spine.slice(1, startAt + 1));
        const j = [];
        for (let k = 0; k < 20; k++) j.push(jit.at(route.spine[startAt + (k % 2)]));
        if (j.some((s) => s.state === 'backtracking' || s.cue)) fail(`${label}: jitter at ${startAt} read as a retreat`);
        if (j.slice(10).some((s) => s.state !== 'stationary')) fail(`${label}: jitter at ${startAt} flickers: ${j.slice(10).map((s) => s.state).join()}`);
      }
    }

    // ---- 6. next waypoint / next_dir: floor, walkable within LOOKAHEAD, one step closer ----
    if (seed <= 5) {
      const tt = newTracker(before);
      const names = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
      for (let f = 0; f < floors.length; f += 3) {
        const p = floors[f];
        const s = tt.at(p);
        if (route.toPortal[p[1] * before.width + p[0]] === 0) continue;
        if (!s.next_waypoint || !s.next_dir) { fail(`${label}: no next step from ${key(p)}`); continue; }
        const w = floorDistances(before, p).get(key(s.next_waypoint));
        if (before.tiles[s.next_waypoint[1]][s.next_waypoint[0]] !== '.') fail(`${label}: next_waypoint is not floor`);
        if (w === undefined || w > 6) fail(`${label}: next_waypoint ${key(s.next_waypoint)} is ${w} steps from ${key(p)}`);
        const [dx, dy] = names[s.next_dir];
        if (before.tiles[p[1] + dy][p[0] + dx] !== '.') fail(`${label}: next_dir ${s.next_dir} from ${key(p)} points into a wall`);
        if (route.toPortal[(p[1] + dy) * before.width + p[0] + dx] !== route.toPortal[p[1] * before.width + p[0]] - 1) fail(`${label}: next_dir is not a step toward the portal`);
      }
    }
  }
  restore();
}

// ---- 6b. a hairpin: two corridors one wall apart, the route doubling back toward the entrance ----
{
  const rows = [
    '###########',
    '#S........#',
    '#########.#',
    '#.........#',
    '#.#########',
    '#........T#',
    '###########',
  ];
  const d = { seed: 0, width: rows[0].length, height: rows.length, tiles: rows.map((r) => r.replace(/[ST]/g, '.')), start: [1, 1], treasure: [9, 5] };
  const route = checkSpine(d, 'hairpin');
  const w = d.width;
  const near = [[1, 1], [1, 3]]; // two cells apart across one wall, 8 + 2 + 8 cells apart on foot
  const a0 = route.attach[near[0][1] * w + near[0][0]], a1 = route.attach[near[1][1] * w + near[1][0]];
  if (a1 - a0 < 16) fail(`hairpin: cells across the wall are ${a1 - a0} apart on the spine, expected 18`);
  const t = newTracker(d);
  const snaps = walk(t, route.spine.slice(1));
  if (snaps.some((s, i) => i >= 8 && s.state !== 'advancing')) fail(`hairpin: walking the route read ${snaps.map((s) => s.state[0]).join('')}`);
  if (snaps.some((s, i) => i && s.progress < snaps[i - 1].progress)) fail('hairpin: progress went down');
  // Standing in the lower corridor right under the start must not read as "near the entrance".
  if (snaps.find((s) => s.distance === a1).progress < 0.5) fail('hairpin: progress under the start is too low');
  const back = walk(t, route.spine.slice(0, route.length).reverse());
  if (!back.some((s) => s.cue)) fail('hairpin: no cue walking the whole way back');
}

// ---- 7. suppression: combat (chasing ghost in sight, hit event) and a known portal withhold the cue ----
{
  const d = generateDungeon(7);
  const route = buildRoute(d);
  const mid = Math.floor(route.length / 2);
  const retreat = (prep) => {
    const t = newTracker(d);
    prep?.(t);
    walk(t, route.spine.slice(1, mid + 1));
    return t;
  };
  // A chasing ghost one cell away, in sight
  {
    const t = retreat();
    t.game.adversaries = [{ id: 'g1', pos: [...route.spine[mid + 1]], mode: 'chase' }];
    const back = [];
    // it keeps pace, one behind; its cell is lit, since sight needs a revealed cell and t.at() teleports without lighting
    for (let k = mid - 1; k >= 0; k--) { const [gx, gy] = route.spine[k + 1]; t.game.adversaries[0].pos = [gx, gy]; t.game.light[gy][gx] ||= 1; back.push(t.at(route.spine[k])); }
    if (back.some((s) => s.cue)) fail('suppression: a chasing visible ghost did not hold the cue');
    if (!back.some((s) => s.state === 'backtracking' && s.suppressed === 'combat')) fail('suppression: expected suppressed combat while backtracking');
  }
  // A non-chasing ghost does not suppress
  {
    const t = retreat();
    t.game.adversaries = [{ id: 'g1', pos: [...route.spine[mid + 1]], mode: 'patrol' }];
    const back = walk(t, route.spine.slice(0, mid).reverse());
    if (!back.some((s) => s.cue)) fail('suppression: a patrolling ghost held the cue');
  }
  // A hit this tick and for 3 ticks after
  {
    const t = retreat();
    const cells = route.spine.slice(0, mid).reverse();
    const out = [];
    cells.forEach((c, i) => out.push(t.at(c, i === 4 ? [{ type: 'hit', id: 'g1' }] : [])));
    // the cue could only start at the 6th step (index 5): the hit at index 4 holds it until index 8
    const firstCue = out.findIndex((s) => s.cue);
    if (firstCue !== -1 && firstCue < 8) fail(`suppression: cue at step ${firstCue} within 3 ticks of a hit`);
    if (!out.slice(4, 8).every((s) => s.suppressed === 'combat')) fail('suppression: hit did not report combat for 4 ticks');
    if (firstCue === -1) fail('suppression: cue never came after the hit lapsed');
  }
  // Portal known
  {
    const t = retreat();
    t.game.light[d.treasure[1]][d.treasure[0]] = 0.5;
    const back = walk(t, route.spine.slice(0, mid).reverse());
    if (back.some((s) => s.cue)) fail('suppression: a known portal did not hold the cue');
    if (!back.some((s) => s.suppressed === 'portal_known')) fail('suppression: expected portal_known');
  }
  // Deliberate detours: healing, collecting coins, or a player directive hold the cue; a plain approach does not
  for (const [name, opts, want] of [['heal', { approach: 'heal' }, 'detour'], ['collect_coins', { approach: 'collect_coins' }, 'detour'],
    ['directive', { approach: 'nearest_frontier', directive: { text: 'go back' } }, 'detour'], ['nearest_frontier', { approach: 'nearest_frontier' }, null]]) {
    const t = retreat();
    const cells = route.spine.slice(0, mid).reverse();
    const out = cells.map((c) => { t.game.pos = [...c]; t.game.steps++; t.tracker.update(t.game, { events: [], ...opts }); return t.tracker.snapshot(); });
    if (want) {
      if (out.some((s) => s.cue)) fail(`suppression: ${name} did not hold the cue`);
      if (!out.some((s) => s.state === 'backtracking' && s.suppressed === 'detour')) fail(`suppression: ${name} did not report detour`);
    } else if (!out.some((s) => s.cue) || out.some((s) => s.suppressed)) fail(`suppression: ${name} should still cue and not be suppressed`);
  }
  // A detour that ends mid-retreat does not burn the cue: it shows once the detour is over
  {
    const t = retreat();
    const cells = route.spine.slice(0, mid).reverse();
    const out = cells.map((c, i) => { t.game.pos = [...c]; t.game.steps++; t.tracker.update(t.game, { events: [], approach: i < 12 ? 'heal' : 'nearest_frontier' }); return t.tracker.snapshot(); });
    if (out.slice(0, 12).some((s) => s.cue) || !out.slice(12).some((s) => s.cue)) fail('suppression: cue should wait out a detour, then show');
  }
  // Priority: over > portal_known > combat > detour
  {
    const t = retreat();
    t.game.light[d.treasure[1]][d.treasure[0]] = 0.5;
    t.game.pos = [...route.spine[mid - 1]]; t.tracker.update(t.game, { events: [{ type: 'hit' }], approach: 'heal' });
    if (t.tracker.snapshot().suppressed !== 'portal_known') fail('suppression: portal_known should outrank combat and detour');
    const u = retreat();
    u.game.pos = [...route.spine[mid - 1]]; u.tracker.update(u.game, { events: [{ type: 'hit' }], approach: 'heal' });
    if (u.tracker.snapshot().suppressed !== 'combat') fail('suppression: combat should outrank detour');
  }
  // Game over
  {
    const t = retreat();
    t.game.lost = true;
    const back = walk(t, route.spine.slice(0, mid).reverse());
    if (back.some((s) => s.cue) || back.at(-1).suppressed !== 'over') fail('suppression: game over');
  }
  // A cue shows once per retreat and re-arms only after advancing; the cooldown holds a second one back
  {
    const t = retreat();
    const back = walk(t, route.spine.slice(0, mid).reverse());
    const episodes = back.filter((s, i) => s.cue && !(i && back[i - 1].cue)).length;
    if (episodes !== 1) fail(`cue episodes in one retreat: ${episodes}`);
    // Advance (re-arms), then retreat again at once: the cooldown (25 ticks) must hold the second cue back.
    const t2 = retreat();
    const ticks = [];
    const spineBack = route.spine.slice(0, mid).reverse();
    for (const c of spineBack.slice(0, 14)) ticks.push(t2.at(c));
    for (const c of route.spine.slice(mid - 13, mid - 3)) ticks.push(t2.at(c)); // 10 forward steps
    for (const c of route.spine.slice(mid - 13, mid - 3).reverse()) ticks.push(t2.at(c)); // and back again
    const starts = ticks.map((s, i) => (s.cue && !(i && ticks[i - 1].cue) ? i : -1)).filter((i) => i >= 0);
    if (starts.length > 1 && starts[1] - starts[0] < 25) fail(`second cue ${starts[1] - starts[0]} ticks after the first (cooldown 25)`);
  }
}

// ---- 8. testbed and the real Run view ----
{
  const wall = '#'.repeat(23);
  const dir = mkdtempSync(join(tmpdir(), 'jev-route-check-'));
  let n = 0;
  const stubs = () => {
    const folder = join(dir, String(++n));
    mkdirSync(folder);
    const d = pathToFileURL(folder + '/');
    const ask = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      if (q.type === 'noul') return [k, { noul: 0.1 }];
      const ids = Object.keys(q.criteria);
      let choice = ids[0];
      if (k === 'sentiment') choice = ids.includes('steady') ? 'steady' : ids[0];
      else if (k === 'tactic') choice = ids.includes('engage') ? 'engage' : ids[0];
      else if (k === 'skill') choice = ids.includes('none') ? 'none' : ids[0];
      else if (k === 'next_move' || k.startsWith('move_if_')) choice = ids.find((id) => id === 'right') ?? ids.find((id) => /Closer to the (?:target|portal)/.test(String(q.criteria[id]))) ?? ids[0];
      return [k, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
    }));
    return { ask, decide: async () => ({}), memoryDir: d, dir: d, confidence: { fixedMood: true } };
  };
  try {
    const none = newTestGame({ map: [wall, '#@' + '.'.repeat(20) + '#', wall, wall, wall], numAdversaries: 0, treasure: null }, stubs());
    if (none.view().route !== null) fail('testbed without a portal: view().route is not null');
    await none.playTurn();
    if (none.view().route !== null) fail('testbed without a portal: route appeared after a tick');
    const withT = newTestGame({ map: [wall, '#@' + '.'.repeat(10) + 'T' + '.'.repeat(9) + '#', wall, wall, wall], numAdversaries: 0 }, stubs());
    const r0 = withT.view().route;
    if (!r0 || r0.length !== 11) fail(`testbed with a portal: route ${JSON.stringify(r0)?.slice(0, 80)}`);

    const KEYS = ['progress', 'furthest', 'distance', 'length', 'offset', 'state', 'next_waypoint', 'next_dir', 'cue', 'suppressed', 'waypoints'];
    const run = newGame(11, stubs());
    let last = null;
    for (let i = 0; i < 20; i++) {
      await run.playTurn();
      const r = run.view().route;
      if (!r) { fail('Run.view().route is null on a generated dungeon'); break; }
      if (Object.keys(r).join() !== KEYS.join()) fail(`route keys ${Object.keys(r).join()}`);
      if (!['advancing', 'exploring', 'backtracking', 'stationary'].includes(r.state)) fail(`bad state ${r.state}`);
      if (r.progress < 0 || r.progress > 1 || r.furthest < r.progress - 1e-9) fail('progress / furthest out of range');
      if (!Array.isArray(r.waypoints) || r.waypoints.some((w) => w.length !== 2)) fail('waypoints shape');
      if (JSON.stringify(run.view().route) !== JSON.stringify(r)) fail('view().route not stable between calls');
      last = r;
    }
    console.log('view().route sample after 20 stubbed ticks:', JSON.stringify({ ...last, waypoints: `[${last.waypoints.length} cells]` }));
    // The turn result must not carry it.
    const turn = await run.playTurn();
    if ('route' in turn) fail('the turn return value carries route');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 9. performance on the largest map ----
{
  configureWorld({ minSize: world.MAX_SIZE, maxSize: world.MAX_SIZE });
  const d = generateDungeon(3);
  restore();
  buildRoute(d); // warm up
  const times = [];
  for (let k = 0; k < 5; k++) { const t0 = performance.now(); buildRoute(d); times.push(performance.now() - t0); }
  const build = Math.max(...times);
  const t = newTracker(d);
  const game = t.game;
  game.adversaries = [{ id: 'g', pos: [...t.route.spine[5]], mode: 'chase' }, { id: 'h', pos: [...t.route.spine[9]], mode: 'patrol' }];
  const N = 1000;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) { game.pos = [...t.route.spine[k % t.route.spine.length]]; t.tracker.update(game, { events: [] }); t.tracker.snapshot(); }
  const upd = (performance.now() - t0) / N;
  console.log(`perf: ${d.width}x${d.height} buildRoute max ${build.toFixed(2)} ms (of 5), ${N} updates avg ${upd.toFixed(4)} ms`);
  if (build >= 50) fail(`buildRoute took ${build.toFixed(1)} ms (limit 50)`);
  if (upd >= 0.2) fail(`tracker update averaged ${upd.toFixed(3)} ms (limit 0.2)`);
}

console.log(`wall-adjacent far pairs examined: ${totalFar}`);
if (totalFar === 0) fail('no wall-adjacent far pairs found: the wall test examined nothing');
restore();
if (failures) {
  console.error(`${failures} route check failure(s)`);
  process.exit(1);
}
console.log('route checks passed');
