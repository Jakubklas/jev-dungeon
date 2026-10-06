// Adversary behaviour checks. No Jev calls: the explorer is driven by applyMove directly, and
// the adversary brains get a stub decider (setDecider) that never touches the network.
// Run from the dungeon-game directory: node scripts/check-adversaries.mjs

import { DIRS, SIGHT_RANGE, applyMove, createGame, floorDistances, generateDungeon, hasLineOfSight, isFloor, legalMoves, rng } from '../src/dungeon.js';
import {
  ADVERSARY_SPEED, CHASE_RANGE, MAX_SEARCH_TICKS, seesExplorer, setDecider, spawnAdversaries, startsChase, stepAdversaries, visibleAdversaries,
} from '../src/characters/adversary/adversary.js';
import { lastRequestBody, memoryOf } from '../src/characters/adversary/brain.js';
import { validateMemory } from '../src/characters/adversary/memory.js';

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
  const game = createGame(dungeon);
  game.lost ??= false;
  game.caughtBy ??= null;
  game.adversaries = [];
  return game;
}
const adversary = (id, pos, extra = {}) => ({ id, pos, mode: 'patrol', budget: 0, lastSeen: null, goal: null, ...extra });

// Stub brain. Moves along the true shortest path to the explorer while the request shows it,
// else to the last-seen cell (or the approach target once there). Records every call.
let stubGame = null; // the game whose dungeon the stub paths over
const stub = { calls: [], keep: 0.9, approach: 'sweep_last_seen', delay: 0, inFlight: 0, maxInFlight: 0, target: null, fail: false };
const resetStub = (game, opts = {}) => {
  stubGame = game;
  Object.assign(stub, { calls: [], keep: 0.9, approach: 'sweep_last_seen', delay: 0, inFlight: 0, maxInFlight: 0, target: null, fail: false }, opts);
};
setDecider(async ({ id, state, questions, body }) => {
  stub.calls.push({ id, state: JSON.parse(body).state, questions: Object.keys(questions), body, at: performance.now() });
  stub.inFlight++;
  stub.maxInFlight = Math.max(stub.maxInFlight, stub.inFlight);
  try {
    if (stub.delay) await new Promise((r) => setTimeout(r, stub.delay));
    if (stub.fail) throw new Error('stub: Jev unavailable');
    const s = state.situation;
    const answers = {};
    if (questions.next_move) {
      const target = stub.target?.(s) ?? (s.explorer.in_sight ? s.explorer.position : same(s.you.position, s.last_seen.cell) ? s.approach_target?.cell ?? s.last_seen.cell : s.last_seen.cell);
      const dist = floorDistances(stubGame.dungeon, target);
      const opts = Object.keys(questions.next_move.criteria);
      const score = (d) => dist.get(`${s.you.position[0] + DIRS[d][0]},${s.you.position[1] + DIRS[d][1]}`) ?? 1e9;
      const choice = opts.reduce((b, d) => (score(d) < score(b) || (score(d) === score(b) && d < b) ? d : b));
      answers.next_move = { choice, probabilities: Object.fromEntries(opts.map((d) => [d, d === choice ? 1 : 0])), confidence: 1 };
    }
    if (questions.search_approach) answers.search_approach = { choice: stub.approach, probabilities: {}, confidence: 1 };
    if (questions.keep_hunting) answers.keep_hunting = { noul: stub.keep };
    return answers;
  } finally {
    stub.inFlight--;
  }
});
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
    const { events } = await stepAdversaries(game);
    const a = game.adversaries[0];
    if (!same(a.pos, prev)) moves++;
    check(Math.abs(a.pos[0] - prev[0]) + Math.abs(a.pos[1] - prev[1]) <= 1, `speed: tick ${tick} moved more than one cell`);
    check(moves === expectedSteps(tick), `speed: ${moves} steps after ${tick} ticks, want ${expectedSteps(tick)}`);
    check(!events.length && a.mode === 'patrol', `speed: patroller changed mode (${a.mode})`);
    prev = [...a.pos];
  }
  check(moves === expectedSteps(400), `speed: ${moves} steps in 400 ticks, want ${expectedSteps(400)}`);
  check(stub.calls.length === 0, `patrol: ${stub.calls.length} brain calls while patrolling, want 0`);
  check(!memoryOf(game.adversaries[0]).brain.on, 'patrol: brain on while patrolling');
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
    const want = Math.min(8, Math.max(1, Math.round(floor / 700)));
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

// 4. Chase: a standing explorer gets closed in on and caught.
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
  check(startsChase(game, a), 'chase: trigger not met within CHASE_RANGE');
  resetStub(game);
  const events = [];
  const startD = pathSteps(game.dungeon, a.pos, game.pos);
  let prev = startD, ticks = 0;
  while (ticks < 40 && !game.lost) {
    ticks++;
    const before = [...a.pos];
    const res = await stepAdversaries(game);
    events.push(...res.events);
    if (ticks === 1) {
      const types = res.events.map((e) => e.type).join();
      check(types === 'spotted,brain_on', `brain_on: first chase tick events ${types}, want spotted,brain_on`);
      check(memoryOf(a).brain.on && memoryOf(a).approach.id === 'direct_pursuit', 'brain_on: memory not on/direct_pursuit');
      check(res.turns[0]?.brain === 'on', 'brain_on: turn not marked on');
    }
    const d = pathSteps(game.dungeon, a.pos, game.pos) ?? 0;
    // Every chaser step is along a true shortest path: the path distance drops by exactly one.
    check(same(before, a.pos) ? d === prev : d === prev - 1, `chase: tick ${ticks} path distance ${prev} -> ${d}`);
    prev = d;
  }
  check(events[0]?.type === 'spotted', 'chase: no spotted event');
  check(game.lost && game.caughtBy === 'a1', 'chase: not caught');
  let wantTicks = 1;
  while (expectedSteps(wantTicks) < startD) wantTicks++;
  check(ticks === wantTicks, `chase: caught after ${ticks} ticks from ${startD} steps, want ${wantTicks}`);
  check(events.some((e) => e.type === 'caught' && e.id === 'a1' && same(e.at, game.pos)), 'chase: no caught event');
  // Every step but the catching one asked the brain (the catch is a code policy).
  check(stub.calls.length === startD - 1, `chase: ${stub.calls.length} brain calls for ${startD} steps, want ${startD - 1}`);
  check(stub.calls.every((c) => c.state.situation.explorer.in_sight && c.questions.join() === 'next_move'), 'chase: chase requests should ask next_move only, explorer in sight');
  check((await stepAdversaries(game)).events.length === 0, 'chase: adversaries still act after the loss');
  check(applyMove(game, 'right').moved === false, 'chase: explorer can still move after the loss');
  check(legalMoves(game).length === 0, 'chase: legalMoves not empty after the loss');
  console.log(`chase: standing explorer caught after ${ticks} ticks from ${startD} path steps`);

  // Stepping into an adversary counts, before any adversary moves.
  const g3 = handMap(['#######', '#E...T#', '#######']);
  const c = adversary('a2', [2, 1], { budget: 0 });
  g3.adversaries = [c];
  applyMove(g3, 'right');
  resetStub(g3);
  const ev3 = (await stepAdversaries(g3)).events;
  check(g3.lost && g3.caughtBy === 'a2' && ev3[0]?.type === 'caught', 'chase: stepping into an adversary is not a loss');
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
  for (const e of (await stepAdversaries(game)).events) log.push([1, e]);
  check(a.mode === 'chase' && same(a.lastSeen, [6, 1]), `search: did not start chasing (mode ${a.mode})`);
  game.pos = [14, 2]; // teleport behind the wall, out of sight
  check(!seesExplorer(game, a), 'search: explorer still visible after teleport');
  const modes = [];
  for (let tick = 2; tick < 40 && !log.some(([, e]) => e.type === 'brain_off'); tick++) {
    for (const e of (await stepAdversaries(game)).events) log.push([tick, e]);
    modes.push(a.mode);
    if (a.mode === 'search') check(!seesExplorer(game, a), 'search: searching while it sees the explorer');
  }
  const types = log.map(([, e]) => e.type);
  const lost = log.find(([, e]) => e.type === 'lost_sight'), off = log.find(([, e]) => e.type === 'brain_off');
  check(types.join() === 'spotted,brain_on,lost_sight,brain_off', `search: events ${types}`);
  check(off && off[0] - lost[0] === MAX_SEARCH_TICKS, `search: brain_off ${off?.[0] - lost?.[0]} ticks after lost_sight, want ${MAX_SEARCH_TICKS}`);
  check(/no sight/.test(off?.[1].reason ?? ''), `search: brain_off reason "${off?.[1].reason}"`);
  check(modes.includes('search') && modes.at(-1) === 'patrol' && a.lastSeen === null, `search: modes ${[...new Set(modes)]}`);
  const searchCalls = stub.calls.filter((c) => !c.state.situation.explorer.in_sight);
  check(searchCalls.length > 0 && searchCalls.every((c) => c.questions.includes('keep_hunting')), 'search: keep_hunting not asked on every search step');
  check(searchCalls.filter((c) => c.questions.includes('search_approach')).length === 1 && searchCalls[0].questions.includes('search_approach'), 'search: search_approach not asked exactly once, on the first search step');
  const m = validateMemory(memoryOf(a));
  check(!m.brain.on && m.approach.id === null && m.approach.tried.some((t) => t.id === 'sweep_last_seen'), 'search: memory after brain_off');
  // Patrolling again: no further brain calls.
  const n = stub.calls.length;
  for (let i = 0; i < 10; i++) await stepAdversaries(game);
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
  const events = [...(await stepAdversaries(game)).events];
  game.pos = [14, 2];
  for (let tick = 0; tick < 6 && !events.some((e) => e.type === 'brain_off'); tick++) events.push(...(await stepAdversaries(game)).events);
  const off = events.find((e) => e.type === 'brain_off');
  check(/keep_hunting 0\.10/.test(off?.reason ?? ''), `keep_hunting: brain_off reason "${off?.reason}"`);
  check(stub.calls.filter((c) => c.questions.includes('keep_hunting')).length === 1, 'keep_hunting: asked more than once before switching off');
  check(a.mode === 'patrol' && !memoryOf(a).brain.on, `keep_hunting: mode ${a.mode} after brain_off`);
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
  const { events, turns } = await stepAdversaries(game);
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
      game.adversaries = [a, adversary('a2', [10, 5])];
      resetStub(game, { target: stayNearLastSeen, approach });
      await stepAdversaries(game);
      game.pos = [...hidden];
      game.trail.push(...trail);
      const from = stub.calls.length;
      for (let t = 0; t < 6; t++) {
        check(!seesExplorer(game, a), `fog: a1 sees the hidden explorer at ${hidden}`);
        await stepAdversaries(game);
      }
      return stub.calls.slice(from).filter((c) => c.id === 'a1').map((c) => c.body);
    } finally {
      Math.random = saved;
    }
  }
  for (const approach of ['sweep_last_seen', 'cut_off']) {
  const A = await run([14, 1], [[13, 1], [14, 1]], approach), B = await run([15, 3], [[15, 4], [15, 3]], approach);
  check(A.length >= 2 && A.length === B.length, `fog: ${A.length} vs ${B.length} search requests`);
  check(A.every((body, i) => body === B[i]), 'fog: adversary request changed when the hidden explorer moved');
  check([...A, ...B].every((b) => !b.includes('[14,1]') && !b.includes('[15,3]') && !b.includes('[13,1]') && !b.includes('[15,4]')), 'fog: hidden explorer coordinates in a request');
  check(A.every((b) => JSON.stringify(JSON.parse(b).state.situation.explorer) === '{"in_sight":false}'), 'fog: explorer block not empty out of sight');
  check(A.every((b) => !/treasure|"light"|"visits"|"trail"/i.test(JSON.stringify(JSON.parse(b).state.situation))), 'fog: treasure or explorer light in situation');
  check(lastRequestBody('a1') === A.at(-1) || lastRequestBody('a1') === B.at(-1), 'fog: lastRequest(id) is not the body sent');
  check(A.slice(1).every((b) => JSON.parse(b).state.memory.approach.id === approach), `fog: approach not ${approach}`);
  console.log(`adversary fog (${approach}): ${A.length} search requests identical for two hidden explorer positions, no explorer coordinates`);
  }
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
  const { turns } = await stepAdversaries(game).finally(() => (console.warn = warn));
  check(turns[0]?.error && turns[0].dir && warned === 1, `fallback: turn ${JSON.stringify(turns[0])}`);
  check(pathSteps(game.dungeon, a.pos, game.pos) === before - 1, 'fallback: code move did not close in');
  check(memoryOf(a).latest_action?.fallback === true, 'fallback: not recorded in memory');
  console.log('fallback: failed brain call -> code BFS move, tick completed');
}

// 6. Random-walk games: never on a wall, and the difficulty signal.
async function walk(seed, policy, maxTicks = 3000) {
  const dungeon = generateDungeon(seed);
  const game = createGame(dungeon);
  game.lost ??= false;
  game.caughtBy ??= null;
  game.adversaries = spawnAdversaries(dungeon);
  resetStub(game);
  const rand = rng(seed * 7919 + 13);
  let chases = 0, lostSight = 0, reacquired = 0;
  for (let tick = 1; tick <= maxTicks; tick++) {
    const legal = legalMoves(game);
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
    applyMove(game, dir);
    if (game.won) return { won: true, tick, chases, lostSight, reacquired, cells: dungeon.width * dungeon.height, n: game.adversaries.length };
    const calls = stub.calls.length;
    const { events } = await stepAdversaries(game);
    for (const c of stub.calls.slice(calls)) {
      check(c.state.memory.brain.on, `walk seed ${seed}: brain call while the brain is off`);
      check(c.state.situation.explorer.in_sight || Object.keys(c.state.situation.explorer).length === 1, `walk seed ${seed}: explorer details out of sight`);
    }
    stub.calls.length = 0;
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

console.log(`CHASE_RANGE ${CHASE_RANGE}, SIGHT_RANGE ${SIGHT_RANGE}`);
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all adversary checks passed');
