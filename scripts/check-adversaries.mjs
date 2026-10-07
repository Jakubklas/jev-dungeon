// Adversary behaviour checks. No Jev calls: the explorer is driven by applyMove directly, and
// the adversary brains get an injected stub `decide` that never touches the network.
// Run from the dungeon-game directory: node scripts/check-adversaries.mjs

// Tripwire: the adversary brains get a stub decider; a missed stub would call the paid Jev API.
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { DIRS, EXPLORER_LIVES, SIGHT_RANGE, Game, floorDistances, generateDungeon, hasLineOfSight, isFloor, rng } from '../src/dungeon.js';
import {
  Adversary, ADVERSARY_SPEED, ALERT_STEPS, CHASE_RANGE, GRACE_TICKS, HIT_DAMAGE, MAX_SEARCH_TICKS, graceLeft, seesExplorer, spawnAdversaries, startsChase, stepAdversaries, visibleAdversaries,
} from '../src/characters/adversary/adversary.js';
import { addEvent, validateMemory } from '../src/characters/adversary/memory.js';
import { configureWorld } from '../src/dungeon.js';
import { configureAdversaries } from '../src/characters/adversary/adversary.js';
import { brainView, buildRequest } from '../src/characters/adversary/brain.js';

let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures <= 25) console.error('FAIL:', msg);
};
const check = (ok, msg) => ok || fail(msg);
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const euclid = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathSteps = (dungeon, a, b) => floorDistances(dungeon, a).get(`${b[0]},${b[1]}`);

// A hand-drawn map. `E` marks the explorer start, `T` the chest; both are floor.
function handMap(rows, rooms = [{ x: 1, y: 1, w: rows[0].length - 2, h: rows.length - 2 }]) {
  let start, treasure;
  const tiles = rows.map((row, y) => [...row].map((c, x) => {
    if (c === 'E') start = [x, y];
    if (c === 'T') treasure = [x, y];
    return c === '#' ? '#' : '.';
  }).join(''));
  const dungeon = { seed: 1, width: rows[0].length, height: rows.length, tiles, start, treasure, rooms };
  const game = new Game(dungeon);
  game.adversaries = [];
  return game;
}
const adversary = (id, pos, extra = {}) => new Adversary({ id, pos, ...extra });

// Stub brain. Moves along the true shortest path to the explorer while the request shows it,
// else to the last-seen cell (or the approach target once there). Records every call.
let stubGame = null; // the game whose dungeon the stub paths over
const stub = { calls: [], keep: 0.9, approach: 'sweep_last_seen', delay: 0, inFlight: 0, maxInFlight: 0, target: null, fail: false };
const resetStub = (game, opts = {}) => {
  stubGame = game;
  Object.assign(stub, { calls: [], keep: 0.9, approach: 'sweep_last_seen', delay: 0, inFlight: 0, maxInFlight: 0, target: null, fail: false }, opts);
};
const decide = async ({ id, state, questions, body }) => {
  stub.calls.push({ id, state: JSON.parse(body).state, questions: Object.keys(questions), body, at: performance.now() });
  stub.inFlight++;
  stub.maxInFlight = Math.max(stub.maxInFlight, stub.inFlight);
  try {
    if (stub.delay) await new Promise((r) => setTimeout(r, stub.delay));
    if (stub.fail) throw new Error('stub: Jev unavailable');
    const s = state;
    const answers = {};
    if (questions.next_move) {
      const target = stub.target?.(s) ?? (s.explorer.in_sight ? s.explorer.position : same(s.self.position, s.last_seen.cell) ? s.approach_target?.cell ?? s.last_seen.cell : s.last_seen.cell);
      const dist = floorDistances(stubGame.dungeon, target);
      const opts = Object.keys(questions.next_move.criteria);
      const score = (d) => dist.get(`${s.self.position[0] + DIRS[d][0]},${s.self.position[1] + DIRS[d][1]}`) ?? 1e9;
      const choice = opts.reduce((b, d) => (score(d) < score(b) || (score(d) === score(b) && d < b) ? d : b));
      answers.next_move = { choice, probabilities: Object.fromEntries(opts.map((d) => [d, d === choice ? 1 : 0])), confidence: 1 };
    }
    if (questions.search_approach) answers.search_approach = { choice: stub.approach, probabilities: {}, confidence: 1 };
    if (questions.keep_hunting) answers.keep_hunting = { noul: stub.keep };
    return answers;
  } finally {
    stub.inFlight--;
  }
};
const step = (game) => stepAdversaries(game, { decide });
// Replays the speed accumulator: steps an adversary takes in `ticks` ticks from budget `b`.
const expectedSteps = (ticks, b = 0) => {
  let n = 0;
  for (let i = 0; i < ticks; i++) {
    b += ADVERSARY_SPEED;
    if (b >= 1) { b -= 1; n++; }
  }
  return n;
};

// 1. Speed: exactly ADVERSARY_SPEED steps per tick on average (replayed accumulator), never more
//    than one per tick (patrol, far from the explorer). Also: no brain calls while patrolling.
{
  check(ADVERSARY_SPEED > 0 && ADVERSARY_SPEED < 1, `ADVERSARY_SPEED is ${ADVERSARY_SPEED}`);
  const open = ['#'.repeat(60), ...Array.from({ length: 30 }, (_, y) => '#' + (y === 0 ? 'ET' : '..') + '.'.repeat(56) + '#'), '#'.repeat(60)];
  // Wall off the explorer's corner so the patroller never sees it.
  const rows = open.map((r, y) => (y >= 1 && y <= 3 ? r.slice(0, 4) + '#' + r.slice(5) : y === 4 ? '#####' + r.slice(5) : r));
  const game = handMap(rows, [{ x: 6, y: 6, w: 52, h: 24 }]);
  game.adversaries = [adversary('a1', [40, 20])];
  resetStub(game);
  let moves = 0, prev = [...game.adversaries[0].pos];
  for (let tick = 1; tick <= 400; tick++) {
    const { events } = await step(game);
    const a = game.adversaries[0];
    if (!same(a.pos, prev)) moves++;
    check(Math.abs(a.pos[0] - prev[0]) + Math.abs(a.pos[1] - prev[1]) <= 1, `speed: tick ${tick} moved more than one cell`);
    check(moves === expectedSteps(tick), `speed: ${moves} steps after ${tick} ticks, want ${expectedSteps(tick)}`);
    check(!events.length && a.mode === 'patrol', `speed: patroller changed mode (${a.mode})`);
    prev = [...a.pos];
  }
  check(moves === expectedSteps(400), `speed: ${moves} steps in 400 ticks, want ${expectedSteps(400)}`);
  check(stub.calls.length === 0, `patrol: ${stub.calls.length} brain calls while patrolling, want 0`);
  check(!game.adversaries[0].memory.brain.on, 'patrol: brain on while patrolling');
  console.log(`speed: ${moves} adversary steps in 400 ticks (ADVERSARY_SPEED ${ADVERSARY_SPEED}); 0 brain calls while patrolling`);
}

// 2. Spawning: distance, sight, count formula, determinism, on room floor.
{
  const SEEDS = 120;
  const counts = {};
  for (let seed = 1; seed <= SEEDS; seed++) {
    const d = generateDungeon(seed);
    const advs = spawnAdversaries(d);
    const floor = d.tiles.join('').split('').filter((c) => c === '.').length;
    const want = Math.min(12, Math.max(1, Math.round(floor / 150))); // one per 150 floor cells, 1..12
    counts[advs.length] = (counts[advs.length] ?? 0) + 1;
    check(advs.length === want, `seed ${seed}: ${advs.length} adversaries for ${floor} floor cells, want ${want}`);
    check(JSON.stringify(spawnAdversaries(generateDungeon(seed))) === JSON.stringify(advs), `seed ${seed}: spawning not deterministic`);
    const dist = floorDistances(d, d.start);
    for (const a of advs) {
      check(isFloor(d, a.pos), `seed ${seed}: ${a.id} spawned on a wall`);
      check((dist.get(a.pos.join()) ?? -1) >= 20, `seed ${seed}: ${a.id} only ${dist.get(a.pos.join())} steps from start`);
      check(!(euclid(a.pos, d.start) <= SIGHT_RANGE && hasLineOfSight(d, d.start, a.pos)), `seed ${seed}: ${a.id} in start sight`);
      check(d.rooms.some((r) => a.pos[0] >= r.x && a.pos[0] < r.x + r.w && a.pos[1] >= r.y && a.pos[1] < r.y + r.h), `seed ${seed}: ${a.id} not in a room`);
      check(a.mode === 'patrol' && a.budget === 0 && a.lastSeen === null, `seed ${seed}: ${a.id} bad initial state`);
    }
    check(new Set(advs.map((a) => a.id)).size === advs.length, `seed ${seed}: duplicate ids`);
  }
  console.log(`spawning: ${SEEDS} seeds checked, adversary counts ${JSON.stringify(counts)}`);
}

// 3. Line of sight is blocked by walls.
{
  const game = handMap([
    '#############',
    '#E....#....T#',
    '#.....#.....#',
    '#############',
  ]);
  const a = adversary('a1', [8, 1]);
  game.adversaries = [a];
  check(!hasLineOfSight(game.dungeon, game.pos, a.pos), 'los: sees through a wall');
  check(!seesExplorer(game, a) && !startsChase(game, a), 'los: adversary sees through a wall');
  check(visibleAdversaries(game).length === 0, 'los: explorer sees through a wall');
  a.pos = [5, 1];
  check(seesExplorer(game, a) && visibleAdversaries(game).length === 1, 'los: open line not seen');
  check(visibleAdversaries(game)[0]?.distance === 4, 'los: visible distance');
  a.pos = [1 + SIGHT_RANGE + 1, 2]; // beyond range: different column so it is through the wall anyway
  check(!seesExplorer(game, a), 'los: seen beyond range');
  console.log('line of sight: walls block, range holds');
}

// 4. Chase and damage: a standing explorer gets closed in on and hit (one life), the hitter is
// knocked back, grace keeps the next touches harmless, and the last life goes on the first touch
// after grace. EXPLORER_LIVES = 2 is assumed by the "first hit is not the loss" checks.
{
  const game = handMap([
    '#################',
    '#E..............#',
    '#...............#',
    '#..............T#',
    '#################',
  ]);
  const a = adversary('a1', [7, 3]);
  game.adversaries = [a];
  check(EXPLORER_LIVES === 2, `damage checks assume 2 lives, EXPLORER_LIVES is ${EXPLORER_LIVES}`);
  check(startsChase(game, a), 'chase: trigger not met within CHASE_RANGE');
  resetStub(game);
  const events = [];
  const startD = pathSteps(game.dungeon, a.pos, game.pos);
  let prev = startD, ticks = 0, hitTick = 0;
  while (ticks < 40 && !hitTick) {
    ticks++;
    const before = [...a.pos];
    const res = await step(game);
    events.push(...res.events);
    if (ticks === 1) {
      const types = res.events.map((e) => e.type).join();
      check(types === 'spotted,brain_on', `brain_on: first chase tick events ${types}, want spotted,brain_on`);
      check(a.memory.brain.on && a.memory.approach.id === 'direct_pursuit', 'brain_on: memory not on/direct_pursuit');
      check(res.turns[0]?.brain === 'on', 'brain_on: turn not marked on');
    }
    if (res.events.some((e) => e.type === 'hit')) hitTick = ticks;
    const d = pathSteps(game.dungeon, a.pos, game.pos) ?? 0;
    // Every chaser step is along a true shortest path: the path distance drops by exactly one.
    // On the hit tick the knockback puts it back on the cell it came from (distance unchanged).
    if (hitTick === ticks) check(same(before, a.pos) && d === prev, `hit: knockback not to the previous cell (${a.pos})`);
    else check(same(before, a.pos) ? d === prev : d === prev - 1, `chase: tick ${ticks} path distance ${prev} -> ${d}`);
    prev = d;
  }
  check(events[0]?.type === 'spotted', 'chase: no spotted event');
  let wantTicks = 1;
  while (expectedSteps(wantTicks) < startD) wantTicks++;
  check(hitTick === wantTicks, `hit: first hit after ${hitTick} ticks from ${startD} steps, want ${wantTicks}`);
  const hit = events.find((e) => e.type === 'hit');
  check(hit?.id === 'a1' && same(hit.at, game.pos) && hit.health === 1, `hit: event ${JSON.stringify(hit)}`);
  check(!game.lost && game.health === 1 && game.caughtBy === null, 'hit: first touch lost the game');
  check(!events.some((e) => e.type === 'caught'), 'hit: caught emitted for a non-lethal hit');
  check(graceLeft(game) === GRACE_TICKS, `hit: grace ${graceLeft(game)}, want ${GRACE_TICKS}`);
  check(!same(a.pos, game.pos), 'hit: hitter still on the explorer');
  // Every step but the hitting one asked the brain (the touch is a code policy).
  check(stub.calls.length === startD - 1, `chase: ${stub.calls.length} brain calls for ${startD} steps, want ${startD - 1}`);
  check(stub.calls.every((c) => c.state.explorer.in_sight && c.questions.join() === 'next_move'), 'chase: chase requests should ask next_move only, explorer in sight');

  // Grace: the adjacent ghost keeps stepping in (forced move) but is bounced and does no damage.
  // It steps every 1/ADVERSARY_SPEED ticks, so the first step after grace is the lethal one.
  const every = Math.round(1 / ADVERSARY_SPEED);
  const wantSecond = hitTick + every * (Math.floor(GRACE_TICKS / every) + 1);
  let secondTick = 0, lastEvents = [];
  while (ticks < hitTick + 40 && !game.lost) {
    ticks++;
    lastEvents = (await step(game)).events;
    if (!game.lost) check(!same(a.pos, game.pos), `grace: ghost left on the explorer at tick ${ticks}`);
    if (lastEvents.some((e) => e.type === 'hit')) secondTick ||= ticks;
  }
  check(secondTick === wantSecond, `grace: second hit at tick ${secondTick}, want ${wantSecond} (grace ${GRACE_TICKS})`);
  check(game.lost && game.caughtBy === 'a1' && game.health === 0, 'chase: not lost after the last life');
  const types = lastEvents.map((e) => e.type).join();
  check(types === 'hit,caught', `chase: lethal tick events ${types}, want hit,caught`);
  check(lastEvents[0]?.health === 0 && same(lastEvents[1]?.at ?? [-1, -1], game.pos), 'chase: lethal hit/caught event shape');
  check((await step(game)).events.length === 0, 'chase: adversaries still act after the loss');
  check(game.applyMove('right').moved === false, 'chase: explorer can still move after the loss');
  check(game.legalMoves().length === 0, 'chase: legalMoves not empty after the loss');
  console.log(`damage: standing explorer hit after ${hitTick} ticks from ${startD} path steps, caught on the next touch after ${GRACE_TICKS} grace ticks (tick ${secondTick})`);

  // Stepping into an adversary costs one life (not the game), before any adversary moves; the
  // adversary is pushed off the cell, not back onto the explorer's previous cell.
  const g3 = handMap(['#######', '#E...T#', '#######']);
  const c = adversary('a2', [2, 1], { budget: 0 });
  g3.adversaries = [c];
  g3.applyMove('right');
  resetStub(g3);
  const ev3 = (await step(g3)).events;
  check(!g3.lost && g3.health === 1 && ev3[0]?.type === 'hit' && ev3[0].id === 'a2', `step-in: ${JSON.stringify(ev3)} health ${g3.health}`);
  check(same(c.pos, [3, 1]), `step-in: a2 knocked to ${c.pos}, want 3,1`);
  check(stub.calls.length === 0, 'step-in: knocked-back adversary still asked its brain this tick');

  // Two ghosts adjacent to a standing explorer, both stepping in this tick: one life, not two.
  const twoGhosts = () => handMap(['#########', '#.......#', '#...E...#', '#......T#', '#########']);
  const g4 = twoGhosts();
  const l = adversary('a1', [3, 2], { budget: 0.5 }), r = adversary('a2', [5, 2], { budget: 0.5 });
  g4.adversaries = [l, r];
  resetStub(g4);
  const ev4 = (await step(g4)).events;
  check(ev4.filter((e) => e.type === 'hit').length === 1 && g4.health === 1 && !g4.lost, `two ghosts adjacent: ${ev4.map((e) => e.type)} health ${g4.health}`);
  check(!same(l.pos, g4.pos) && !same(r.pos, g4.pos), 'two ghosts adjacent: a ghost left on the explorer');

  // Two ghosts already on the explorer's cell before anything moves: one life, both pushed off.
  const g5 = twoGhosts();
  const p = adversary('a2', [4, 2]), q = adversary('a1', [4, 2]);
  g5.adversaries = [p, q]; // array order != id order: the hit goes to a1 (id order)
  resetStub(g5);
  const ev5 = (await step(g5)).events;
  const hits5 = ev5.filter((e) => e.type === 'hit');
  check(hits5.length === 1 && hits5[0].id === 'a1' && g5.health === 1 && !g5.lost, `two ghosts on the cell: ${JSON.stringify(hits5)} health ${g5.health}`);
  check(!same(p.pos, g5.pos) && !same(q.pos, g5.pos), 'two ghosts on the cell: a ghost left on the explorer');

  // Grace stops an immediate re-hit: the explorer steps straight back into a ghost next tick.
  const g6 = twoGhosts();
  const s6 = adversary('a1', [4, 2]);
  g6.adversaries = [s6];
  resetStub(g6);
  await step(g6); // hit, a1 knocked off
  const from6 = [...g6.pos];
  const dir6 = Object.keys(DIRS).find((d) => same([from6[0] + DIRS[d][0], from6[1] + DIRS[d][1]], s6.pos));
  g6.applyMove(dir6);
  const ev6 = (await step(g6)).events;
  check(g6.health === 1 && !ev6.some((e) => e.type === 'hit') && !same(s6.pos, g6.pos), `grace: re-hit right after a hit (${ev6.map((e) => e.type)}, health ${g6.health})`);
  check(graceLeft(g6) === GRACE_TICKS - 1, `grace: ${graceLeft(g6)} left after one tick, want ${GRACE_TICKS - 1}`);
  console.log('damage: step-in costs a life, two ghosts cost one life per tick, grace blocks a re-hit');
}

// 5. Losing sight: chase -> search (brain still on) -> brain_off after MAX_SEARCH_TICKS -> patrol.
const twoRooms = () => handMap([
  '#################',
  '#.......#......T#',
  '#.......#.......#',
  '#.......#.......#',
  '#...............#',
  '#E......#.......#',
  '#################',
], [{ x: 1, y: 1, w: 7, h: 5 }, { x: 9, y: 1, w: 7, h: 5 }]);
const stayNearLastSeen = (s) => s.last_seen?.cell ?? s.explorer.position;
{
  const game = twoRooms();
  game.pos = [6, 1];
  const a = adversary('a1', [2, 1]);
  game.adversaries = [a];
  resetStub(game, { target: stayNearLastSeen });
  const log = []; // [tick, event]
  for (const e of (await step(game)).events) log.push([1, e]);
  check(a.mode === 'chase' && same(a.lastSeen, [6, 1]), `search: did not start chasing (mode ${a.mode})`);
  game.pos = [14, 2]; // teleport behind the wall, out of sight
  check(!seesExplorer(game, a), 'search: explorer still visible after teleport');
  const modes = [];
  for (let tick = 2; tick < 40 && !log.some(([, e]) => e.type === 'brain_off'); tick++) {
    for (const e of (await step(game)).events) log.push([tick, e]);
    modes.push(a.mode);
    if (a.mode === 'search') check(!seesExplorer(game, a), 'search: searching while it sees the explorer');
  }
  const types = log.map(([, e]) => e.type);
  const lost = log.find(([, e]) => e.type === 'lost_sight'), off = log.find(([, e]) => e.type === 'brain_off');
  check(types.join() === 'spotted,brain_on,lost_sight,brain_off', `search: events ${types}`);
  check(off && off[0] - lost[0] === MAX_SEARCH_TICKS, `search: brain_off ${off?.[0] - lost?.[0]} ticks after lost_sight, want ${MAX_SEARCH_TICKS}`);
  check(/no sight/.test(off?.[1].reason ?? ''), `search: brain_off reason "${off?.[1].reason}"`);
  check(modes.includes('search') && modes.at(-1) === 'patrol' && a.lastSeen === null, `search: modes ${[...new Set(modes)]}`);
  const searchCalls = stub.calls.filter((c) => !c.state.explorer.in_sight);
  check(searchCalls.length > 0 && searchCalls.every((c) => c.questions.includes('keep_hunting')), 'search: keep_hunting not asked on every search step');
  check(searchCalls.filter((c) => c.questions.includes('search_approach')).length === 1 && searchCalls[0].questions.includes('search_approach'), 'search: search_approach not asked exactly once, on the first search step');
  const m = validateMemory(a.memory);
  check(!m.brain.on && m.approach.id === null && m.approach.tried.some((t) => t.id === 'sweep_last_seen'), 'search: memory after brain_off');
  // Patrolling again: no further brain calls.
  const n = stub.calls.length;
  for (let i = 0; i < 10; i++) await step(game);
  check(stub.calls.length === n || a.mode !== 'patrol', 'search: brain calls after brain_off');
  console.log(`losing sight: ${types.join(' -> ')} (brain_off after ${MAX_SEARCH_TICKS} ticks without sight: "${off?.[1].reason}")`);
}

// 5b. keep_hunting below 0.5 switches the brain off at the first search step.
{
  const game = twoRooms();
  game.pos = [6, 1];
  const a = adversary('a1', [2, 1]);
  game.adversaries = [a];
  resetStub(game, { target: stayNearLastSeen, keep: 0.1 });
  const events = [...(await step(game)).events];
  game.pos = [14, 2];
  for (let tick = 0; tick < 6 && !events.some((e) => e.type === 'brain_off'); tick++) events.push(...(await step(game)).events);
  const off = events.find((e) => e.type === 'brain_off');
  check(/keep_hunting 0\.10/.test(off?.reason ?? ''), `keep_hunting: brain_off reason "${off?.reason}"`);
  check(stub.calls.filter((c) => c.questions.includes('keep_hunting')).length === 1, 'keep_hunting: asked more than once before switching off');
  check(a.mode === 'patrol' && !a.memory.brain.on, `keep_hunting: mode ${a.mode} after brain_off`);
  console.log(`keep_hunting 0.1: brain_off ("${off?.reason}")`);
}

// 5c. Parallel: brain-on adversaries stepping in the same tick ask at the same time.
{
  const game = handMap([
    '###############',
    '#.............#',
    '#.............#',
    '#......E.....T#',
    '#.............#',
    '###############',
  ]);
  const a1 = adversary('a1', [2, 3], { budget: 0.9 }), a2 = adversary('a2', [12, 1], { budget: 0.9 });
  game.adversaries = [a1, a2];
  resetStub(game, { delay: 40 });
  const started = performance.now();
  const { events, turns } = await step(game);
  const ms = performance.now() - started;
  check(events.filter((e) => e.type === 'brain_on').length === 2, 'parallel: both brains not on');
  check(stub.calls.length === 2 && stub.maxInFlight === 2, `parallel: ${stub.calls.length} calls, max ${stub.maxInFlight} in flight, want 2/2`);
  check(ms < 75, `parallel: tick took ${Math.round(ms)} ms with two 40 ms calls (sequential?)`);
  check(turns.map((t) => t.id).join() === 'a1,a2' && turns.every((t) => t.dir && t.brain === 'on'), `parallel: turns ${JSON.stringify(turns.map((t) => [t.id, t.dir]))}`);
  console.log(`parallel: 2 brain calls overlapped (max ${stub.maxInFlight} in flight), tick took ${Math.round(ms)} ms`);
}

// 5d. Adversary fog of war: out of sight, the request holds no explorer position. Twin test:
//     two games that differ only in where the hidden explorer is (and its hidden trail) must
//     send byte-identical adversary requests.
{
  async function run(hidden, trail, approach) {
    const saved = Math.random;
    Math.random = rng(4242); // option shuffles, identical in both games
    try {
      const game = twoRooms();
      game.pos = [6, 1];
      game.trail.push([5, 1], [6, 1]); // heading right when seen
      const a = adversary('a1', [2, 1], { budget: 0.5 });
      // a2 stays in the first room: a packmate that saw the hidden explorer would (by design) tell a1.
      const a2 = adversary('a2', [2, 5]);
      game.adversaries = [a, a2];
      resetStub(game, { target: stayNearLastSeen, approach });
      await step(game);
      game.pos = [...hidden];
      game.trail.push(...trail);
      const from = stub.calls.length;
      for (let t = 0; t < 6; t++) {
        check(!seesExplorer(game, a) && !seesExplorer(game, a2), `fog: a1 or a2 sees the hidden explorer at ${hidden}`);
        await step(game);
      }
      return { bodies: stub.calls.slice(from).filter((c) => c.id === 'a1').map((c) => c.body), last: a.lastRequestBody };
    } finally {
      Math.random = saved;
    }
  }
  for (const approach of ['sweep_last_seen', 'cut_off']) {
  const RA = await run([14, 1], [[13, 1], [14, 1]], approach), RB = await run([15, 3], [[15, 4], [15, 3]], approach);
  const A = RA.bodies, B = RB.bodies;
  check(A.length >= 2 && A.length === B.length, `fog: ${A.length} vs ${B.length} search requests`);
  check(A.every((body, i) => body === B[i]), 'fog: adversary request changed when the hidden explorer moved');
  check([...A, ...B].every((b) => !b.includes('[14,1]') && !b.includes('[15,3]') && !b.includes('[13,1]') && !b.includes('[15,4]')), 'fog: hidden explorer coordinates in a request');
  check(A.every((b) => JSON.stringify(JSON.parse(b).state.explorer) === '{"in_sight":false}'), 'fog: explorer block not empty out of sight');
  check(A.every((b) => !/treasure|"light"|"visits"|"trail"/i.test(JSON.stringify({ ...JSON.parse(b).state, game: null }))), 'fog: treasure or explorer light in state');
  check(RA.last === A.at(-1) && RB.last === B.at(-1), 'fog: lastRequestBody is not the body sent');
  check(A.slice(1).every((b) => JSON.parse(b).state.self.approach.id === approach), `fog: approach not ${approach}`);
  console.log(`adversary fog (${approach}): ${A.length} search requests identical for two hidden explorer positions, no explorer coordinates`);
  }
}

// 5d2. Pack hunting: a spotter alerts patrolling packmates within ALERT_STEPS (path), who join the
//      hunt at the spot it saw the explorer; a hunting adversary then tracks the explorer
//      through any packmate's sight (team sight).
{
  const game = twoRooms();
  game.pos = [6, 1];
  const a1 = adversary('a1', [2, 1]);
  const a2 = adversary('a2', [14, 3]); // other room, behind the wall: cannot see [6,1]
  game.adversaries = [a1, a2];
  resetStub(game, { target: stayNearLastSeen });
  check(!seesExplorer(game, a2), 'pack: a2 should start out of sight');
  const { events } = await step(game);
  check(events.some((e) => e.type === 'alerted' && e.id === 'a2' && e.by === 'a1'), `pack: no alerted event for a2 (${events.map((e) => e.type)})`);
  // a2 hears the call, then tracks the explorer through a1's sight at once, so it is already chasing.
  check(a2.memory.brain.on && a2.mode === 'chase' && same(a2.lastSeen, [6, 1]), `pack: a2 not hunting at [6,1] (${a2.mode}, ${a2.lastSeen})`);
  // Team sight: the explorer slips out of a1's view into a2's room; a1 keeps chasing through a2's eyes.
  game.pos = [14, 1];
  check(seesExplorer(game, a2) || !seesExplorer(game, a1), 'pack: setup, a2 or nobody sees the explorer');
  check(!seesExplorer(game, a1), 'pack: a1 should not see [14,1] itself');
  game.pos = [a2.pos[0], a2.pos[1] - 1];
  check(seesExplorer(game, a2) && !seesExplorer(game, a1), 'pack: setup for team sight');
  await step(game);
  check(a1.mode === 'chase', `pack: a1 lost the explorer despite a2 seeing it (mode ${a1.mode})`);
  console.log(`pack: spotter alerts a packmate within ${ALERT_STEPS} path steps; hunter tracks the explorer through a packmate's sight`);
}

// 5e. A failing brain call falls back to the code move; the tick still completes.
{
  const game = handMap([
    '#################',
    '#E..............#',
    '#...............#',
    '#..............T#',
    '#################',
  ]);
  const a = adversary('a1', [7, 3], { budget: 0.9 });
  game.adversaries = [a];
  resetStub(game, { fail: true });
  const before = pathSteps(game.dungeon, a.pos, game.pos);
  const warn = console.warn;
  let warned = 0;
  console.warn = () => warned++;
  const { turns } = await step(game).finally(() => (console.warn = warn));
  check(turns[0]?.error && turns[0].dir && warned === 1, `fallback: turn ${JSON.stringify(turns[0])}`);
  check(pathSteps(game.dungeon, a.pos, game.pos) === before - 1, 'fallback: code move did not close in');
  check(a.memory.latest_action?.fallback === true, 'fallback: not recorded in memory');
  console.log('fallback: failed brain call -> code BFS move, tick completed');
}

// 5f. Memory shape: re-sighting does not flood `tried`, the tally counts, events stay few, and the
//     request carries surroundings and team. No probabilities reach Jev; the UI view keeps them.
{
  const game = twoRooms();
  const a = adversary('a1', [2, 1]);
  game.adversaries = [a];
  resetStub(game, { target: stayNearLastSeen });
  const CYCLES = 6;
  for (let i = 0; i < CYCLES; i++) {
    a.pos = [2, 1];
    game.pos = [6, 1];
    await step(game); // in sight (the first one switches the brain on)
    game.pos = [14, 2];
    await step(game); // out of sight
    await step(game);
  }
  let m = validateMemory(a.memory);
  check(m.brain.on, 'memory: brain should still be on after the cycles');
  check(m.tally.sightings === CYCLES && m.tally.lost_sight === CYCLES && m.tally.hits === 0 && m.tally.alerts_heard === 0, `memory: tally ${JSON.stringify(m.tally)} after ${CYCLES} sight/lost cycles`);
  check(m.approach.tried.every((t) => t.id === 'cut_off' || t.id === 'sweep_last_seen'), `memory: tried holds a non-search approach ${JSON.stringify(m.approach.tried)}`);
  check(m.approach.tried.length === 0, `memory: ${m.approach.tried.length} flip-flop rows in tried after ${CYCLES} cycles`);
  check(m.events.length === 1 && /^First sighting/.test(m.events[0].text), `memory: events after repeated sightings ${JSON.stringify(m.events)}`);
  check(!('findings' in m) && Object.keys(m).join() === 'id,objective,brain,approach,tally,events,progress,latest_action', `memory: keys ${Object.keys(m)}`);
  // A search approach that is replaced by giving up is recorded once.
  game.pos = [14, 2];
  for (let i = 0; i < MAX_SEARCH_TICKS + 2 && a.memory.brain.on; i++) await step(game);
  m = validateMemory(a.memory);
  check(m.approach.tried.length === 1 && m.approach.tried[0].id === 'sweep_last_seen', `memory: tried after giving up ${JSON.stringify(m.approach.tried)}`);
  check(m.events.at(-1).text.startsWith('Gave up') && m.events.length === 2, `memory: events after giving up ${JSON.stringify(m.events)}`);
  // The events cap and the no-duplicate-tick rule.
  for (let i = 0; i < 12; i++) addEvent(m, `moment ${i}`, i + 100);
  check(m.events.length === 5 && m.events[0].text === 'moment 7', `memory: events cap ${m.events.length}`);
  validateMemory(m);
  let threw = false;
  try { validateMemory({ ...m, events: [{ tick: 9, text: 'Lost sight at tick 9' }] }); } catch { threw = true; }
  check(threw, 'memory: an event repeating its tick in the text was accepted');
  threw = false;
  try { validateMemory({ ...m, latest_action: { choice: 'up', confidence: 1, forced: false, fallback: false, probabilities: { up: 1 } } }); } catch { threw = true; }
  check(threw, 'memory: latest_action.probabilities was accepted');

  // What Jev reads.
  const g2 = twoRooms();
  const h1 = adversary('a1', [2, 1], { budget: 0.9 }), h2 = adversary('a2', [2, 5]), h3 = adversary('a3', [14, 3], { budget: 0 });
  g2.pos = [6, 1];
  g2.adversaries = [h1, h2, h3];
  resetStub(g2, { target: stayNearLastSeen });
  await step(g2);
  const call = JSON.parse(stub.calls.find((c) => c.id === 'a1').body);
  check(Object.keys(call.state).join() === 'game,tick,self,surroundings,explorer,last_seen,team,recent', `state keys ${Object.keys(call.state)}`);
  check(Object.keys(call.state.self).join() === 'id,position,mode,approach,latest_action', `self keys ${Object.keys(call.state.self)}`);
  const sur = call.state.surroundings;
  check(sur.here === 'room' && Number.isInteger(sur.exits) && Number.isInteger(sur.dead_ends_within_5) && 'nearest_junction_or_doorway' in sur, `surroundings ${JSON.stringify(sur)}`);
  check(sur.nearest_junction_or_doorway === null || (typeof sur.nearest_junction_or_doorway.direction === 'string' && sur.nearest_junction_or_doorway.path_steps > 0), `nearest_junction_or_doorway ${JSON.stringify(sur)}`);
  check(call.state.team.map((t) => t.id).join() === 'a2,a3' && call.state.team.every((t) => ['pursuing', 'searching', 'patrolling'].includes(t.role) && Number.isInteger(t.path_steps)), `team ${JSON.stringify(call.state.team)}`);
  check(Object.keys(call.state.recent).join() === 'tally,events,progress', `recent keys ${Object.keys(call.state.recent)}`);
  // No probabilities in anything Jev reads, from the first request to the latest.
  await step(g2);
  check(stub.calls.every((c) => !c.body.includes('"probabilities"')), 'state: probabilities sent to Jev');
  const view = brainView(h1);
  check(Object.keys(view).join() === 'on,approach,approach_text,approach_since,objective,latest_action,last_reason', `brainView keys ${Object.keys(view)}`);
  check(view.latest_action && Object.keys(view.latest_action).join() === 'choice,probabilities,confidence' && view.latest_action.probabilities, `brainView latest_action ${JSON.stringify(view.latest_action)}`);
  check(Object.keys(h1).join() === 'id,pos,mode,budget,lastSeen,goal', `public Adversary shape ${Object.keys(h1)}`);

  // A hit is counted and noted.
  const g3 = twoRooms();
  const hitter = adversary('a1', [2, 1], { budget: 0.9 });
  g3.pos = [3, 1];
  g3.adversaries = [hitter];
  resetStub(g3);
  const { events } = await step(g3);
  check(events.some((e) => e.type === 'hit'), 'memory: setup, no hit');
  m = validateMemory(hitter.memory);
  check(m.tally.hits === 1 && m.events.some((e) => /^Hit the explorer/.test(e.text)), `memory: hit not recorded ${JSON.stringify(m.tally)} ${JSON.stringify(m.events)}`);
  console.log(`memory: ${CYCLES} sight/lost cycles -> tally ${JSON.stringify(m.tally)} for the hit run, no flip-flop rows in tried, events capped at 5, surroundings and team in the request`);
}

// 6. Random-walk games: never on a wall, and the difficulty signal.
async function walk(seed, policy, maxTicks = 3000) {
  const dungeon = generateDungeon(seed);
  const game = new Game(dungeon);
  game.adversaries = spawnAdversaries(dungeon);
  resetStub(game);
  const rand = rng(seed * 7919 + 13);
  let chases = 0, lostSight = 0, reacquired = 0;
  for (let tick = 1; tick <= maxTicks; tick++) {
    const legal = game.legalMoves();
    let dir;
    const chasers = policy === 'flee' ? visibleAdversaries(game).filter((v) => v.mode === 'chase') : [];
    if (chasers.length) {
      // Run from visible chasers: the move that keeps the nearest one furthest away (by real path).
      const maps = chasers.map((c) => floorDistances(dungeon, c.pos));
      const score = (d) => Math.min(...maps.map((m) => m.get(`${game.pos[0] + DIRS[d][0]},${game.pos[1] + DIRS[d][1]}`) ?? 0));
      dir = legal.reduce((best, d) => (score(d) > score(best) ? d : best));
    } else if (policy === 'fresh' || policy === 'flee') {
      // Prefer never-visited neighbours, else random: a crude explorer. 'flee' also runs from chasers.
      const fresh = legal.filter((d) => !game.visits[`${game.pos[0] + DIRS[d][0]},${game.pos[1] + DIRS[d][1]}`]);
      const pool = fresh.length ? fresh : legal;
      dir = pool[Math.floor(rand() * pool.length)];
    } else {
      dir = legal[Math.floor(rand() * legal.length)];
    }
    game.applyMove(dir);
    if (game.won) return { won: true, tick, chases, lostSight, reacquired, cells: dungeon.width * dungeon.height, n: game.adversaries.length };
    const calls = stub.calls.length;
    const { events } = await step(game);
    for (const c of stub.calls.slice(calls)) {
      check(c.state.self.approach.id !== null, `walk seed ${seed}: brain call while the brain is off`);
      check(typeof c.state.surroundings.here === 'string' && c.state.team.every((t) => ['pursuing', 'searching', 'patrolling'].includes(t.role)), `walk seed ${seed}: surroundings or team malformed`);
      check(!c.body.includes('"probabilities"'), `walk seed ${seed}: probabilities sent to Jev`);
      check(c.state.explorer.in_sight || Object.keys(c.state.explorer).length === 1, `walk seed ${seed}: explorer details out of sight`);
    }
    stub.calls.length = 0;
    if (tick % 50 === 0) game.adversaries.forEach((a) => validateMemory(a.memory));
    chases += events.filter((e) => e.type === 'brain_on').length;
    lostSight += events.filter((e) => e.type === 'lost_sight').length;
    // A 'spotted' without a 'brain_on' for the same adversary in the same tick: re-acquired mid-hunt.
    reacquired += events.filter((e) => e.type === 'spotted' && !events.some((o) => o.type === 'brain_on' && o.id === e.id)).length;

    for (const a of game.adversaries) check(isFloor(dungeon, a.pos), `walk seed ${seed}: ${a.id} on a wall at ${a.pos}`);
    if (game.lost) return { lost: true, tick, chases, lostSight, reacquired, cells: dungeon.width * dungeon.height, n: game.adversaries.length };
  }
  return { timeout: true, tick: maxTicks, chases, lostSight, reacquired, cells: dungeon.width * dungeon.height, n: game.adversaries.length };
}

for (const policy of ['random', 'fresh', 'flee']) {
  const GAMES = 40;
  const results = [];
  const started = performance.now();
  for (let seed = 1001; seed < 1001 + GAMES; seed++) results.push(await walk(seed, policy));
  const ms = performance.now() - started;
  const lost = results.filter((r) => r.lost), won = results.filter((r) => r.won), out = results.filter((r) => r.timeout);
  const avg = (rs) => (rs.length ? Math.round(rs.reduce((s, r) => s + r.tick, 0) / rs.length) : '-');
  const totalTicks = results.reduce((s, r) => s + r.tick, 0);
  const byCount = {};
  for (const r of results) {
    const b = (byCount[r.n] ??= { games: 0, caught: 0 });
    b.games++;
    if (r.lost) b.caught++;
  }
  const big = results.filter((r) => r.cells >= 100 * 100);
  console.log(
    `  by adversary count: ${Object.entries(byCount).map(([n, b]) => `${n} adv ${b.caught}/${b.games} caught`).join(', ')}; ` +
      `maps >=100x100: ${big.length} games, ${big.filter((r) => r.lost).length} caught`,
  );
  console.log(
    `walker '${policy}': ${GAMES} games, caught ${lost.length} (${Math.round((lost.length / GAMES) * 100)}%, avg tick ${avg(lost)}), ` +
      `won ${won.length} (avg tick ${avg(won)}), timed out ${out.length}; ` +
      `${(results.reduce((s, r) => s + r.chases, 0) / GAMES).toFixed(1)} chases/game, ` +
      `${(results.reduce((s, r) => s + r.lostSight, 0) / GAMES).toFixed(1)} lost_sight/game, ${(results.reduce((s, r) => s + r.reacquired, 0) / GAMES).toFixed(1)} re-spotted mid-hunt/game; ` +
      `${(ms / totalTicks).toFixed(3)} ms/tick`,
  );
}

// 9. The rules text follows the live tunables (sight range, grace ticks, hit damage), not hard-coded numbers.
{
  const rulesText = async () => {
    const game = twoRooms();
    game.pos = [6, 1];
    const a = adversary('a1', [2, 1]);
    game.adversaries = [a];
    resetStub(game);
    await step(game); // starts the chase (code policy)
    game.pos = [14, 2]; // out of sight: a search step, which asks Jev
    const req = buildRequest(game, a, 2, { speed: ADVERSARY_SPEED, maxSearchTicks: MAX_SEARCH_TICKS, hitDamage: HIT_DAMAGE, graceTicks: GRACE_TICKS });
    return req.state?.game ?? '';
  };
  const before = await rulesText();
  check(before.includes(`within ${SIGHT_RANGE} cells`), `rules: sight range ${SIGHT_RANGE} missing from "${before}"`);
  const old = { sight: SIGHT_RANGE, grace: GRACE_TICKS, damage: HIT_DAMAGE };
  configureWorld({ sightRange: 9 });
  configureAdversaries({ graceTicks: 6, hitDamage: 2 });
  try {
    const after = await rulesText();
    check(after.includes('within 9 cells') && after !== before, 'rules: text did not follow sightRange 9');
    check(after.includes('cannot be hurt for 6 ticks') && after.includes('loses 2 lives'), 'rules: text did not follow graceTicks/hitDamage');
  } finally {
    configureWorld({ sightRange: old.sight });
    configureAdversaries({ graceTicks: old.grace, hitDamage: old.damage });
  }
  check((await rulesText()) === before, 'rules: text not restored after the tunables were put back');
  console.log('rules: text follows sight range, grace ticks and hit damage');
}

console.log(`CHASE_RANGE ${CHASE_RANGE}, SIGHT_RANGE ${SIGHT_RANGE}`);
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all adversary checks passed');
