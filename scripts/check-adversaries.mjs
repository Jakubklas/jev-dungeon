// Adversary behaviour checks. No Jev calls: the explorer is driven by applyMove directly, and
// the adversary brains get an injected stub `decide` that never touches the network.
// Run from the dungeon-game directory: node scripts/check-adversaries.mjs

// Tripwire: the adversary brains get a stub decider; a missed stub would call the paid Jev API.
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { DIRS, EXPLORER_LIVES, SIGHT_RANGE, Game, floorDistances, generateDungeon, hasLineOfSight, isFloor, rng } from '../src/dungeon.js';
import { REQUEST_BYTES } from '../src/config/registry.js'; // the one definition of the request-size bounds
import {
  Adversary, ADVERSARY_SPEED, ALERT_STEPS, CHASE_RANGE, GRACE_TICKS, MAX_SEARCH_TICKS, adversaryView, graceLeft, seesExplorer, spawnAdversaries, startsChase, stepAdversaries, visibleAdversaries,
} from '../src/characters/adversary/adversary.js';
import { addEvent, createMemory, validateMemory } from '../src/characters/adversary/memory.js';
import { configureWorld } from '../src/dungeon.js';
import { configureAdversaries } from '../src/characters/adversary/adversary.js';
import { brainView, buildRequest, configureAdversaryBrain } from '../src/characters/adversary/brain.js';
import { AdversaryView } from '../src/characters/adversary/adversary-view.js';
import { EXPLORER, resolveAttack } from '../src/skills/resolve.js';
import { skillConfig, configureSkills } from '../src/skills/config.js';
import { buildSkillSet } from '../src/skills/loadouts.js';
import { kindOf } from '../src/characters/adversary/kinds.js';
import { profileOf, traitsOf } from '../src/characters/adversary/character.js';

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
const clawDamageNow = (a) => a.skills.skills.find((k) => k.kind === 'attack')?.damage ?? 1;
const adversary = (id, pos, extra = {}) => new Adversary({ id, pos, ...extra });

// Stub brain. Moves along the true shortest path to the explorer while the request shows it,
// else to the last-seen cell (or the approach target once there). Records every call.
let stubGame = null; // the game whose dungeon the stub paths over
const stub = { calls: [], keep: 0.9, approach: 'sweep_last_seen', delay: 0, inFlight: 0, maxInFlight: 0, target: null, fail: false, strike: false };
const resetStub = (game, opts = {}) => {
  stubGame = game;
  Object.assign(stub, { calls: [], keep: 0.9, approach: 'sweep_last_seen', delay: 0, inFlight: 0, maxInFlight: 0, target: null, fail: false, strike: false }, opts);
};
let maxBody = { bytes: 0, questions: '' }; // largest ghost request seen, for the report
const decide = async ({ id, state, questions, body }) => {
  if (Buffer.byteLength(body) > maxBody.bytes) maxBody = { bytes: Buffer.byteLength(body), questions: Object.keys(questions).join() };
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
    if (questions.skill) {
      const keys = Object.keys(questions.skill.criteria).filter((k) => k !== 'none');
      const choice = stub.strike && keys.length ? keys[0] : 'none';
      answers.skill = { choice, probabilities: { [choice]: 1 }, confidence: 1 };
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

// 4. Chase and damage (PLAN-skills.md S4): a touch is only a BUMP. A hunting ghost hurts the explorer with its claw
// strike (the `skill` question rides in next_move's request), grace and the one-hit-per-tick latch apply to strikes,
// and the last life goes on the first strike after grace. EXPLORER_LIVES = 2 is assumed by "first hit is not the loss".
// A ghost with a zero-cooldown claw (clawGhost) strikes on every step it takes; the default claw has cooldown 2.
const clawGhost = (id, pos, extra = {}) => adversary(id, pos, { skills: buildSkillSet(['claw_strike'], { claw_strike: { cooldown: 0 } }), ...extra });
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
  resetStub(game, { strike: true });
  const events = [], allTurns = [];
  const startD = pathSteps(game.dungeon, a.pos, game.pos);
  let prev = startD, ticks = 0, hitTick = 0;
  while (ticks < 40 && !hitTick) {
    ticks++;
    const before = [...a.pos];
    const res = await step(game);
    events.push(...res.events);
    allTurns.push(res.turns[0]);
    if (ticks === 1) {
      const types = res.events.map((e) => e.type).join();
      check(types === 'spotted,brain_on', `brain_on: first chase tick events ${types}, want spotted,brain_on`);
      check(a.memory.brain.on && a.memory.approach.id === 'direct_pursuit', 'brain_on: memory not on/direct_pursuit');
      check(res.turns[0]?.brain === 'on', 'brain_on: turn not marked on');
    }
    if (res.events.some((e) => e.type === 'hit')) hitTick = ticks;
    const d = pathSteps(game.dungeon, a.pos, game.pos) ?? 0;
    // Every chaser step is along a true shortest path. On the hit tick the claw strikes first, then the ghost steps
    // onto the explorer (a bump) and is pushed back to the cell it came from: the distance is unchanged.
    if (hitTick === ticks) check(same(before, a.pos) && d === prev, `hit: bump knockback not to the previous cell (${a.pos})`);
    else check(same(before, a.pos) ? d === prev : d === prev - 1, `chase: tick ${ticks} path distance ${prev} -> ${d}`);
    prev = d;
  }
  check(events[0]?.type === 'spotted', 'chase: no spotted event');
  let wantTicks = 1;
  while (expectedSteps(wantTicks) < startD) wantTicks++;
  check(hitTick === wantTicks, `hit: first hit after ${hitTick} ticks from ${startD} steps, want ${wantTicks}`);
  const hit = events.find((e) => e.type === 'hit');
  check(hit?.id === 'a1' && same(hit.at, game.pos) && hit.health === EXPLORER_LIVES - 1, `hit: event ${JSON.stringify(hit)}`);
  const hitTypes = events.slice(events.findIndex((e) => e.type === 'hit')).map((e) => e.type).join();
  check(hitTypes === 'hit,strike,bump', `hit: strike tick events ${hitTypes}, want hit,strike,bump`);
  check(events.find((e) => e.type === 'strike')?.result === 'hit', 'hit: strike result not hit');
  check(!game.lost && game.health === EXPLORER_LIVES - 1 && game.caughtBy === null, 'hit: first strike lost the game');
  check(!events.some((e) => e.type === 'caught'), 'hit: caught emitted for a non-lethal hit');
  check(graceLeft(game) === GRACE_TICKS, `hit: grace ${graceLeft(game)}, want ${GRACE_TICKS}`);
  check(!same(a.pos, game.pos), 'hit: hitter still on the explorer');
  check(a.facing === Object.keys(DIRS).find((d) => same([a.pos[0] + DIRS[d][0], a.pos[1] + DIRS[d][1]], game.pos)), `hit: ghost faces ${a.facing}, want the aim at the explorer`);
  // Every step asked the brain (a bump is no longer a forced code policy); only the last request carries the skill.
  check(stub.calls.length === startD, `chase: ${stub.calls.length} brain calls for ${startD} steps, want ${startD}`);
  check(stub.calls.slice(0, -1).every((c) => c.state.explorer.in_sight && c.questions.join() === 'next_move'), 'chase: far requests should ask next_move only, explorer in sight');
  check(stub.calls.at(-1).questions.join() === 'next_move,skill', `chase: adjacent request asks ${stub.calls.at(-1).questions}, want next_move,skill in one request`);
  check(JSON.parse(stub.calls.at(-1).body).questions.skill.criteria.none !== undefined && Object.keys(JSON.parse(stub.calls.at(-1).body).questions.skill.criteria)[0] === 'none', 'chase: none is not the first skill option');

  // Turn data: skill_decision is null when no skill question was asked, and { choice, probabilities, used } when it was.
  const lastTurn = allTurns.at(-1);
  const clawKey = Object.keys(JSON.parse(stub.calls.at(-1).body).questions.skill.criteria).find((k) => k !== 'none');
  check(allTurns.slice(0, -1).every((t) => t.skill_decision === null), 'turn: skill_decision not null without a skill question');
  check(lastTurn.skill_decision?.choice === clawKey && lastTurn.skill_decision.used === clawKey && lastTurn.skill_decision.probabilities?.[clawKey] === 1, `turn: claw skill_decision ${JSON.stringify(lastTurn.skill_decision)}, want choice and used ${clawKey}`);

  // Grace: the adjacent ghost keeps going but its claw is blocked by hit protection ('protected').
  // With four lives the ghost must land all four separated strikes before the last one is lethal.
  let secondTick = 0, lastEvents = [];
  const sawProtected = [];
  while (ticks < hitTick + 60 && !game.lost) {
    ticks++;
    lastEvents = (await step(game)).events;
    if (!game.lost) check(!same(a.pos, game.pos), `grace: ghost left on the explorer at tick ${ticks}`);
    for (const e of lastEvents) if (e.type === 'strike' && e.result === 'protected') sawProtected.push(ticks);
    if (lastEvents.some((e) => e.type === 'hit')) secondTick ||= ticks;
  }
  check(secondTick > hitTick + GRACE_TICKS, `grace: second hit at tick ${secondTick}, inside grace (hit ${hitTick}, grace ${GRACE_TICKS})`);
  check(game.lost && game.caughtBy === 'a1' && game.health === 0, 'chase: not lost after the last life');
  const types = lastEvents.map((e) => e.type).join();
  check(types === 'hit,caught,strike', `chase: lethal tick events ${types}, want hit,caught,strike`);
  check(lastEvents[0]?.health === 0 && same(lastEvents[1]?.at ?? [-1, -1], game.pos), 'chase: lethal hit/caught event shape');
  check(sawProtected.length >= EXPLORER_LIVES - 1, 'grace: a hit did not protect the explorer before each later claw');
  check((await step(game)).events.length === 0, 'chase: adversaries still act after the loss');
  check(game.applyMove('right').moved === false, 'chase: explorer can still move after the loss');
  check(game.legalMoves().length === 0, 'chase: legalMoves not empty after the loss');
  console.log(`damage: standing explorer struck after ${hitTick} ticks from ${startD} path steps, its next hit after ${GRACE_TICKS} grace ticks was tick ${secondTick}, caught after ${EXPLORER_LIVES} hits`);

  // Stepping into an adversary is only a bump: no life, no grace, no brain call; the ghost is pushed off the cell.
  const g3 = handMap(['#######', '#E...T#', '#######']);
  const c = adversary('a2', [2, 1], { budget: 0 });
  g3.adversaries = [c];
  g3.applyMove('right');
  resetStub(g3);
  const ev3 = (await step(g3)).events;
  check(ev3.length >= 1 && ev3[0].type === 'bump' && ev3[0].id === 'a2' && same(ev3[0].at, g3.pos), `step-in: ${JSON.stringify(ev3)}`);
  check(!ev3.some((e) => e.type === 'hit' || e.type === 'caught') && !g3.lost && g3.health === EXPLORER_LIVES && graceLeft(g3) === 0, `step-in: a bump cost something (health ${g3.health}, grace ${graceLeft(g3)})`);
  check(same(c.pos, [3, 1]), `step-in: a2 knocked to ${c.pos}, want 3,1`);
  check(stub.calls.length === 0, 'step-in: knocked-back adversary still asked its brain this tick');

  // Two adjacent ghosts that both strike this tick: one life, not two (the one-hit-per-tick latch).
  const twoGhosts = () => handMap(['#########', '#.......#', '#...E...#', '#......T#', '#########']);
  const g4 = twoGhosts();
  const l = clawGhost('a1', [3, 2], { budget: 0.5 }), r = clawGhost('a2', [5, 2], { budget: 0.5 });
  g4.adversaries = [l, r];
  resetStub(g4, { strike: true });
  const ev4 = (await step(g4)).events;
  const strikes4 = ev4.filter((e) => e.type === 'strike');
  check(ev4.filter((e) => e.type === 'hit').length === 1 && g4.health === EXPLORER_LIVES - 1 && !g4.lost, `two ghosts strike: ${ev4.map((e) => e.type)} health ${g4.health}`);
  check(strikes4.length === 2 && strikes4[0].result === 'hit' && strikes4[1].result === 'protected', `two ghosts strike: results ${strikes4.map((e) => e.result)}, want hit,protected`);
  check(!same(l.pos, g4.pos) && !same(r.pos, g4.pos), 'two ghosts strike: a ghost left on the explorer');
  check(g4.strikes.length === 2 && g4.strikes.every((s) => s.by === 'a1' || s.by === 'a2'), 'two ghosts strike: game.strikes does not hold both flashes');

  // Two ghosts already on the explorer's cell before anything moves: two bumps, no life lost, both pushed off.
  const g5 = twoGhosts();
  const p = adversary('a2', [4, 2]), q = adversary('a1', [4, 2]);
  g5.adversaries = [p, q];
  resetStub(g5);
  const ev5 = (await step(g5)).events;
  const bumps5 = ev5.filter((e) => e.type === 'bump');
  check(bumps5.length === 2 && bumps5[0].id === 'a1' && bumps5[1].id === 'a2' && !ev5.some((e) => e.type === 'hit') && g5.health === EXPLORER_LIVES, `two ghosts on the cell: ${JSON.stringify(ev5)} health ${g5.health}`);
  check(!same(p.pos, g5.pos) && !same(q.pos, g5.pos), 'two ghosts on the cell: a ghost left on the explorer');

  // Grace stops an immediate re-hit: a zero-cooldown claw keeps striking next tick, 'protected', no life lost.
  const g6 = twoGhosts();
  const s6 = clawGhost('a1', [3, 2]);
  g6.adversaries = [s6];
  resetStub(g6, { strike: true });
  s6.budget = 1;
  const first6 = (await step(g6)).events;
  check(first6.some((e) => e.type === 'hit') && g6.health === EXPLORER_LIVES - 1, `grace: first strike did not hit (${first6.map((e) => e.type)})`);
  s6.pos = [3, 2]; s6.budget = 1;
  g6.clearTickState();
  const ev6 = (await step(g6)).events;
  check(g6.health === EXPLORER_LIVES - 1 && !ev6.some((e) => e.type === 'hit') && ev6.some((e) => e.type === 'strike' && e.result === 'protected'), `grace: re-hit right after a hit (${ev6.map((e) => e.type)}, health ${g6.health})`);
  check(graceLeft(g6) === GRACE_TICKS - 1, `grace: ${graceLeft(g6)} left after one tick, want ${GRACE_TICKS - 1}`);
  check(g6.strikes.length === 1 && g6.strikes[0].result === 'protected', 'grace: game.strikes holds this tick\'s flash');

  // A patrolling ghost (brain off) never strikes: it is next to the explorer, resting after a give-up, so it only
  // patrols; no call, no strike event.
  const g7 = twoGhosts();
  const pat = clawGhost('a1', [3, 2], { budget: 1 });
  pat.hunt.restUntil = 999;
  g7.adversaries = [pat];
  resetStub(g7, { strike: true });
  const ev7 = (await step(g7)).events;
  check(!pat.hunt.on && stub.calls.length === 0 && !ev7.some((e) => e.type === 'strike' || e.type === 'hit') && g7.health === EXPLORER_LIVES, `patrol: a brain-off ghost struck (${ev7.map((e) => e.type)})`);
  check(Object.keys(DIRS).includes(pat.facing), 'patrol: facing is a 4-way direction');

  // Shield vs claw: a block stops the claw (event 'blocked', no life, no latch); a failed roll lets it land; the
  // roll is seeded, so the same seed gives the same outcomes.
  const blockGame = (eff) => {
    const g = twoGhosts();
    g.adversaries = [clawGhost('a1', [3, 2], { budget: 1 })];
    g.block = { effectiveness: eff, until_step: g.steps + 1 };
    return g;
  };
  resetStub(null, { strike: true });
  const gb = blockGame(1);
  stubGame = gb;
  const evb = (await step(gb)).events;
  check(evb.some((e) => e.type === 'blocked') && !evb.some((e) => e.type === 'hit') && gb.health === EXPLORER_LIVES && graceLeft(gb) === 0, `block: effectiveness 1 did not stop the claw (${evb.map((e) => e.type)})`);
  check(gb.strikes[0]?.result === 'blocked', 'block: strike result not blocked');
  const gn = blockGame(0);
  stubGame = gn;
  const evn = (await step(gn)).events;
  check(evn.some((e) => e.type === 'hit') && gn.health === EXPLORER_LIVES - 1, `block: effectiveness 0 stopped the claw (${evn.map((e) => e.type)})`);
  const rolls = async () => {
    const out = [];
    for (let i = 0; i < 12; i++) {
      const g = blockGame(0.6);
      stubGame = g;
      g.dungeon.seed = 1000 + i;
      g.skillRand = null;
      out.push((await step(g)).events.some((e) => e.type === 'blocked'));
    }
    return out.join();
  };
  const r1 = await rolls(), r2 = await rolls();
  check(r1 === r2 && r1.includes('true') && r1.includes('false'), `block: seeded rolls differ between runs or never vary (${r1} / ${r2})`);
  // Bump-lock: a 1-wide corridor, a hunting ghost, an explorer that steps onto it every tick. A bump keeps the
  // ghost's budget, so it still acts (claw strike) within a few ticks instead of being pushed along forever.
  const g8 = handMap(['###########', '#E........#', '###########']);
  const lock = clawGhost('a1', [3, 1]);
  g8.adversaries = [lock];
  resetStub(g8, { strike: true });
  let strikeTick = 0, bumps8 = 0;
  for (let t = 1; t <= 6 && !strikeTick; t++) {
    g8.clearTickState();
    const dir = same(lock.pos, [g8.pos[0] + 1, g8.pos[1]]) ? 'right' : null;
    if (dir) g8.applyMove(dir);
    const ev = (await step(g8)).events;
    bumps8 += ev.filter((e) => e.type === 'bump').length;
    if (ev.some((e) => e.type === 'hit' || (e.type === 'strike' && e.result === 'protected'))) strikeTick = t;
  }
  check(strikeTick > 0 && strikeTick <= 4 && bumps8 >= 1, `bump-lock: explorer pushing a ghost down a corridor was struck at tick ${strikeTick} after ${bumps8} bumps`);
  console.log(`bump-lock: bumped ghost struck at tick ${strikeTick} (${bumps8} bumps)`);
  stubGame = g6;
  console.log('damage: a touch is a bump, claw strikes hurt, grace and the one-hit latch hold, patrollers never strike, shield rolls are seeded');
}

// 4b. Ghost state and the skill request: six public keys, private hp/stun/facing/skills, takeHit, stun, dispel,
// skill-only requests, requests built synchronously in id order, character lines.
{
  const a = adversary('a1', [3, 3]);
  check(Object.keys(a).join() === 'id,pos,mode,budget,lastSeen,goal' && Object.keys(JSON.parse(JSON.stringify(a))).join() === 'id,pos,mode,budget,lastSeen,goal', `ghost keys: ${Object.keys(a)}`);
  check(a.hp === 2 && a.maxHp === 2 && a.stun === 0 && a.facing === 'down' && a.skills.size === 1 && a.skills.skills[0].id === 'claw_strike', 'ghost private defaults (hp 2, no stun, facing down, one claw)');
  check(a.memory.skills.length === 1 && a.memory.skills[0].id === 'claw_strike' && a.memory.skills[0].ready === true && validateMemory(a.memory) === a.memory, 'memory.skills mirrors the claw and validates');
  let threw = false;
  try { validateMemory({ ...a.memory, skills: [1, 2, 3, 4, 5].map(() => a.memory.skills[0]) }); } catch { threw = true; }
  check(threw, 'memory: 5 skills accepted');
  threw = false;
  try { validateMemory({ ...a.memory, skills: [{ ...a.memory.skills[0], extra: 1 }] }); } catch { threw = true; }
  check(threw, 'memory: a skill with an extra key accepted');
  a.facing = 'left';
  check(a.facing === 'left', 'facing accessor');
  threw = false;
  try { a.facing = 'north'; } catch { threw = true; }
  check(threw, 'facing accepts a non-direction');
  // takeHit: knockback directly away on the dominant axis, stun, hp; dispel at 0. Never into a wall or the attacker.
  const g = handMap(['#######', '#.....#', '#..E..#', '#.....#', '#######']);
  const t = adversary('a1', [4, 2]);
  g.adversaries = [t];
  const out = t.takeHit(1, [...g.pos], g);
  check(out.hp === 1 && !out.dispelled && same(t.pos, [5, 2]) && t.stun === skillConfig().stunTicks && t.budget === 0, `takeHit: ${JSON.stringify(out)} pos ${t.pos} stun ${t.stun}`);
  check(t.takeHit(1, [...g.pos], g).dispelled === true, 'takeHit: last hp dispels');
  const w = adversary('a1', [5, 2]); // against the east wall: stays put
  w.takeHit(1, [4, 2], g);
  check(same(w.pos, [5, 2]) && w.hp === 1 && w.stun === skillConfig().stunTicks, 'takeHit: knockback into a wall keeps the cell');
  const ng = adversary('a1', [4, 2]);
  ng.takeHit(1, [3, 2]); // no game: hp and stun only
  check(same(ng.pos, [4, 2]) && ng.hp === 1, 'takeHit: no game, no knockback');

  // Stun: the explorer's strike stuns a hunting ghost; it makes no Jev call and does not step for stun ticks.
  const g2 = handMap(['#################', '#E..............#', '#...............#', '#..............T#', '#################']);
  const s = adversary('a1', [4, 1]);
  g2.adversaries = [s];
  resetStub(g2);
  await step(g2); // spotted: brain on
  check(s.hunt.on && stub.calls.length === 0, 'stun setup: ghost not hunting');
  const flash = resolveAttack(g2, EXPLORER, [[4, 1]], 1);
  check(flash.some((e) => e.type === 'struck') && s.stun === skillConfig().stunTicks, 'stun: the explorer\'s strike did not stun');
  const where = [...s.pos];
  const stunTurns = [];
  for (let i = 0; i < skillConfig().stunTicks; i++) {
    const res = await step(g2);
    stunTurns.push(res.turns[0]);
    check(same(s.pos, where) && stub.calls.length === 0 && res.turns[0].stunned === true && res.turns[0].dir === null, `stun: tick ${i + 1} stepped or called Jev`);
  }
  check(s.stun === 0 && s.budget === 0, `stun: ghost has stun ${s.stun}, budget ${s.budget} after the stun`);
  let moved = 0;
  for (let i = 0; i < 4 && !moved; i++) { await step(g2); moved = stub.calls.length; }
  check(moved >= 1, 'stun: the ghost never resumed');

  // Dispel: a 1-hp ghost struck by the explorer leaves the game cleanly; the next tick runs and the other ghost acts.
  const g3 = handMap(['#################', '#E..............#', '#...............#', '#..............T#', '#################']);
  const weak = adversary('a1', [3, 1], { hp: 1 }), other = adversary('a2', [9, 3]);
  g3.adversaries = [weak, other];
  resetStub(g3);
  await step(g3);
  const kill = resolveAttack(g3, EXPLORER, [[3, 1]], 1);
  check(kill.some((e) => e.type === 'dispelled' && e.id === 'a1') && g3.adversaries.length === 1 && g3.adversaries[0] === other, 'dispel: ghost not removed from the game');
  const after = await step(g3);
  check(after.turns.length === 1 && after.turns[0].id === 'a2' && !g3.adversaries.includes(weak), 'dispel: next tick still lists the dispelled ghost');

  // Skill-only request (one legal move, explorer adjacent): the request holds only the `skill` question.
  const g4 = handMap(['######', '#..EA#', '######']);
  const dead = clawGhost('a1', [4, 1], { budget: 1 });
  g4.adversaries = [dead];
  resetStub(g4, { strike: true });
  const ev4 = (await step(g4)).events;
  check(stub.calls.length === 1 && stub.calls[0].questions.join() === 'skill', `skill-only: asked ${stub.calls.map((c) => c.questions)}, want one skill-only request`);
  check(ev4.some((e) => e.type === 'hit') && g4.health === EXPLORER_LIVES - 1, `skill-only: the claw did not land (${ev4.map((e) => e.type)})`);
  check(same(dead.pos, [4, 1]), 'skill-only: forced step onto the explorer was not a bump back');
  // Same cornered ghost with nothing to strike (explorer out of reach): forced move, no call.
  const g5 = handMap(['#######', '#E....#', '#.#####', '#.....#', '#######']);
  const far = clawGhost('a1', [5, 3], { budget: 1 });
  g5.adversaries = [far];
  resetStub(g5, { strike: true });
  far.hunt.on = true; far.hunt.inSight = false; far.mode = 'search'; far.lastSeen = [1, 1];
  await step(g5);
  check(!stub.calls.some((c) => c.questions.includes('skill')), 'skill: asked with the explorer out of reach');

  // Fog: the skill question appears only with the explorer adjacent AND in sight; `state` never gains a position.
  const g6 = handMap(['#########', '#.......#', '#...EA..#', '#.......#', '#########']);
  const near = clawGhost('a1', [5, 2], { budget: 1 });
  g6.adversaries = [near];
  resetStub(g6);
  await step(g6);
  const req = near.lastRequest();
  check(req && req.questions.skill && Object.keys(req.questions.skill.criteria).join() === 'none,claw_strike_left', `skill request criteria: ${req && Object.keys(req.questions?.skill?.criteria ?? {})}`);
  check(req.state.self.skills.length === 1 && req.state.self.skills[0].id === 'claw_strike' && !('text' in req.state.self.skills[0]), 'state.self.skills holds the summary without text');
  check(/Besides the move/.test(req.questions.skill.instructions.question) && !/Strike whenever|only when cornered/.test(req.questions.skill.instructions.question), 'standard ghost: no aggression line');
  check(/claw strike/.test(req.state.game) && /only bumps/.test(req.state.game) && /Touching is harmless/.test(req.state.game), 'rules(): touches only bump, the claw strike takes a life');
  check(req.questions.next_move.criteria.left?.includes('only a bump') && req.questions.next_move.instructions.priorities.every((x) => !x.startsWith('Skills:')), 'move facts: stepping onto the explorer is only a bump');

  // Character lines: aggression 3 / 1 add the strike line; caution 3 wakes keepDistance.
  for (const [character, line] of [['aggressive', 'Strike whenever the explorer is adjacent and the claw is ready.'], ['timid', 'Strike only when cornered.']]) {
    const gc = handMap(['#########', '#.......#', '#...EA..#', '#.......#', '#########']);
    const c = clawGhost('a1', [5, 2], { budget: 1, character });
    gc.adversaries = [c];
    resetStub(gc);
    await step(gc);
    const rq = c.lastRequest();
    check(rq.questions.skill.instructions.question.endsWith(line) && rq.questions.next_move.instructions.priorities.includes(`Skills: ${line}`), `character ${character}: strike line missing`);
  }
  const gk = handMap(['#########', '#.......#', '#...EA..#', '#.......#', '#########']);
  const cautious = clawGhost('a1', [5, 2], { budget: 1 });
  cautious.hunt.profile = profileOf({ ...traitsOf('standard'), caution: 3 });
  gk.adversaries = [cautious];
  resetStub(gk);
  await step(gk);
  check(cautious.lastRequest().questions.next_move.instructions.priorities.some((x) => /keep at least 2 cells/.test(x)), 'caution 3: keepDistance line missing');
  const gs = handMap(['#########', '#.......#', '#...EA..#', '#.......#', '#########']);
  const plain = clawGhost('a1', [5, 2], { budget: 1 });
  gs.adversaries = [plain];
  resetStub(gs);
  await step(gs);
  check(!plain.lastRequest().questions.next_move.instructions.priorities.some((x) => /keep at least/.test(x)), 'standard ghost got a keepDistance line');
  // Fog twin: a ghost the explorer cannot be seen from gets no skill question, whatever the explorer's cell.
  const gt = handMap(['#########', '#.......#', '#...E...#', '#.......#', '#########']);
  const hid = clawGhost('a1', [7, 2], { budget: 1 });
  hid.hunt.on = true; hid.hunt.inSight = false; hid.mode = 'search'; hid.lastSeen = [4, 2]; hid.hunt.pickApproach = false;
  hid.memory.approach.id = 'sweep_last_seen'; hid.memory.brain.on = true;
  gt.adversaries = [hid];
  resetStub(gt);
  gt.pos = [1, 3];
  hid.hunt.restUntil = 0;
  const reqs = [buildRequest(new AdversaryView(gt, hid), hid, 3, { speed: ADVERSARY_SPEED, maxSearchTicks: MAX_SEARCH_TICKS, hitDamage: 1, graceTicks: GRACE_TICKS })];
  gt.pos = [2, 1];
  reqs.push(buildRequest(new AdversaryView(gt, hid), hid, 3, { speed: ADVERSARY_SPEED, maxSearchTicks: MAX_SEARCH_TICKS, hitDamage: 1, graceTicks: GRACE_TICKS }));
  check(JSON.stringify(JSON.parse(reqs[0].body).state) === JSON.stringify(JSON.parse(reqs[1].body).state) && !reqs[0].questions.skill && !reqs[1].questions.skill, 'fog: a searching ghost\'s state depends on the explorer cell, or it asked a skill');

  // Requests are built synchronously in id order: after the un-awaited call, every Jev call has already started.
  const g7 = handMap(['#################', '#E..............#', '#...............#', '#..............T#', '#################']);
  const m2 = adversary('a2', [6, 3], { budget: 1 }), m1 = adversary('a1', [7, 3], { budget: 1 });
  g7.adversaries = [m2, m1]; // array order != id order
  resetStub(g7, { delay: 5 });
  const pending = step(g7);
  check(stub.calls.map((c) => c.id).join() === 'a1,a2', `sync: ${stub.calls.map((c) => c.id)} started before the first await, want a1,a2`);
  await pending;
  console.log('ghost state: six keys, takeHit, stun, dispel, skill-only request, character lines and sync requests ok');
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
  // This block's stub teleports and shuttles on purpose to count re-sightings; monster tabu (PLAN-tabu phase 5) would
  // rightly rule that stall out and add events, so it is off here (check-tabu section 6 covers the tabu behaviour).
  configureAdversaryBrain({ advTabuEnabled: false });
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
  check(!('findings' in m) && Object.keys(m).join() === 'id,character,objective,brain,approach,tally,events,progress,latest_action,sightings,recent,landmarks,lifetime,morale,skills', `memory: keys ${Object.keys(m)}`);
  // A search approach that is replaced by giving up is recorded once.
  game.pos = [14, 2];
  for (let i = 0; i < MAX_SEARCH_TICKS + 2 && a.memory.brain.on; i++) await step(game);
  m = validateMemory(a.memory);
  check(m.approach.tried.length === 1 && m.approach.tried[0].id === 'sweep_last_seen', `memory: tried after giving up ${JSON.stringify(m.approach.tried)}`);
  check(m.events.at(-1).text.startsWith('Gave up') && m.events.length === 2, `memory: events after giving up ${JSON.stringify(m.events)}`);
  configureAdversaryBrain({ advTabuEnabled: true });
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
  check(Object.keys(call.state.self).join() === 'id,position,mode,approach,latest_action,skills', `self keys ${Object.keys(call.state.self)}`);
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
  const hitter = clawGhost('a1', [2, 1], { budget: 0.9 });
  g3.pos = [3, 1];
  g3.adversaries = [hitter];
  resetStub(g3, { strike: true });
  const { events } = await step(g3);
  check(events.some((e) => e.type === 'hit'), `memory: setup, no hit (${events.map((e) => e.type)})`);
  m = validateMemory(hitter.memory);
  check(m.tally.hits === 1 && m.events.some((e) => /^Hit the explorer/.test(e.text)), `memory: hit not recorded ${JSON.stringify(m.tally)} ${JSON.stringify(m.events)}`);
  console.log(`memory: ${CYCLES} sight/lost cycles -> tally ${JSON.stringify(m.tally)} for the hit run, no flip-flop rows in tried, events capped at 5, surroundings and team in the request`);
}

// 6. Random-walk games: never on a wall, and the difficulty signal.
async function walk(seed, policy, maxTicks = 800) {
  const dungeon = generateDungeon(seed);
  const game = new Game(dungeon);
  game.adversaries = spawnAdversaries(dungeon);
  resetStub(game, { strike: true }); // ghosts strike when a claw option is offered, so games end
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
  const GAMES = 24; // informational stats; kept small so the whole check stays fast
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
    const req = buildRequest(new AdversaryView(game, a), a, 2, { speed: ADVERSARY_SPEED, maxSearchTicks: MAX_SEARCH_TICKS, hitDamage: clawDamageNow(a), graceTicks: GRACE_TICKS });
    return req.state?.game ?? '';
  };
  const before = await rulesText();
  check(before.includes(`within ${SIGHT_RANGE} cells`), `rules: sight range ${SIGHT_RANGE} missing from "${before}"`);
  const old = { sight: SIGHT_RANGE, grace: GRACE_TICKS, claw: skillConfig() };
  configureWorld({ sightRange: 9 });
  configureAdversaries({ graceTicks: 6 });
  configureSkills({ ...skillConfig(), clawDamage: 2 });
  try {
    const after = await rulesText();
    check(after.includes('within 9 cells') && after !== before, 'rules: text did not follow sightRange 9');
    check(after.includes('cannot be hurt for 6 ticks') && after.includes('loses 2 lives'), 'rules: text did not follow graceTicks/clawDamage');
  } finally {
    configureWorld({ sightRange: old.sight });
    configureAdversaries({ graceTicks: old.grace });
    configureSkills(old.claw);
  }
  check((await rulesText()) === before, 'rules: text not restored after the tunables were put back');
  console.log('rules: text follows sight range, grace ticks and claw damage');
}

// AdversaryView (full mode): the API brain and perception use, and the explorer-in-sight guard.
{
  const g = handMap([
    '#########',
    '#E......#',
    '#.#####.#',
    '#.......#',
    '#########',
  ]);
  const a = adversary('a1', [7, 1]);
  const b = adversary('a2', [1, 3]);
  g.adversaries = [a, b];
  const view = new AdversaryView(g, a);
  check(view.mode === 'full', 'view: full mode');
  check(same(view.pos, [7, 1]), 'view: pos follows the adversary live');
  a.pos = [7, 2];
  check(same(view.pos, [7, 2]), 'view: pos is live, not cached');
  a.pos = [7, 1];
  check(view.explorer() === null && view.heading() === null, 'view: no explorer position or heading out of sight');
  a.hunt.inSight = true;
  g.trail = [[1, 1], [2, 1]];
  check(same(view.explorer(), g.pos) && view.explorer() !== g.pos, 'view: explorer() is a copy of the explorer cell while in sight');
  check(view.heading() === 'right', `view: heading ${view.heading()}`);
  a.hunt.inSight = false;
  check(view.explorer() === null && view.heading() === null, 'view: out of sight again, nothing leaks');
  check(view.legalMoves().join() === 'down,left', `view: legal moves ${view.legalMoves()}`);
  check(view.distancesFrom([1, 1]).get('7,3') === 8 && !view.distancesFrom([1, 1]).has('2,2'), 'view: path distances over floor only');
  check(view.kindOf([4, 1]).kind === 'corridor' || view.kindOf([4, 1]).kind === 'room', 'view: kindOf answers');
  check(view.cellsInView().every((c) => isFloor(g.dungeon, c) && euclid(c, a.pos) <= SIGHT_RANGE), 'view: cellsInView is floor within sight range');
  const mates = view.teammates();
  check(mates.length === 1 && mates[0].id === 'a2' && mates[0].role === 'patrolling', `view: teammates ${JSON.stringify(mates)}`);
  b.hunt.on = true;
  check(view.teammates()[0].role === 'searching', 'view: teammate role follows its hunt');
  // A view never keeps hold of another game: the same ghost in a twin game gets its own state.
  console.log('view: full-mode API ok');
}


// 11. Characters (A2 wiring): per-trait behaviour with the stub decider. Standard ghosts keep today's numbers.
{
  // maxSearchTicks 10 / 18 / 32: ticks from lost_sight to brain_off.
  const searchTicks = async (character) => {
    const game = twoRooms();
    game.pos = [6, 1];
    const a = adversary('a1', [2, 1], { character });
    game.adversaries = [a];
    resetStub(game, { target: stayNearLastSeen });
    const log = [];
    for (const e of (await step(game)).events) log.push([1, e]);
    game.pos = [14, 2];
    for (let tick = 2; tick < 80 && !log.some(([, e]) => e.type === 'brain_off'); tick++) for (const e of (await step(game)).events) log.push([tick, e]);
    const lost = log.find(([, e]) => e.type === 'lost_sight'), off = log.find(([, e]) => e.type === 'brain_off');
    return off && lost ? off[0] - lost[0] : null;
  };
  for (const [character, want] of [['short_sighted', 10], ['standard', MAX_SEARCH_TICKS], ['pursuer', 32]]) {
    const got = await searchTicks(character);
    check(got === want, `character ${character}: brain_off ${got} ticks after lost_sight, want ${want}`);
  }

  // A calm ghost does not start a hunt at distance 6; a standard one does; both start at 5.
  {
    const game = twoRooms();
    game.pos = [7, 1];
    const calm = adversary('a1', [1, 1], { character: 'timid' }), std = adversary('a2', [1, 1]);
    game.adversaries = [calm, std];
    check(!startsChase(game, calm) && startsChase(game, std), 'timid does not start a chase at distance 6, standard does');
    calm.pos = [2, 1];
    check(startsChase(game, calm), 'timid starts a chase at distance 5');
  }

  // Rest after giving up: a calm ghost (aggression 1) waits restTicks before it hunts again; standard does not wait.
  {
    const game = twoRooms();
    game.pos = [4, 1];
    const a = adversary('a1', [2, 1], { character: 'timid' });
    game.adversaries = [a];
    resetStub(game, { target: stayNearLastSeen, keep: 0.1 });
    const events = [...(await step(game)).events];
    game.pos = [14, 2];
    for (let tick = 0; tick < 6 && !events.some((e) => e.type === 'brain_off'); tick++) events.push(...(await step(game)).events);
    check(events.some((e) => e.type === 'brain_off'), 'timid: gave up on a low keep_hunting');
    const rest = a.hunt.restUntil - game.adversaryTicks;
    check(rest >= 5 && rest <= 6, `timid rests ${rest} ticks after giving up, want 6`);
    game.pos = [a.pos[0] + 1, a.pos[1]]; // right next to it, in sight
    const again = [];
    for (let i = 0; i < 4; i++) again.push(...(await step(game)).events);
    check(!again.some((e) => e.type === 'brain_on'), 'timid hunts again while resting');
    const std = adversary('s1', [2, 1]);
    check(std.hunt.restUntil === 0, 'standard ghost has no rest');
  }

  // Loners neither call nor answer; hearing range follows the pack level.
  {
    const room = (rows) => handMap(rows, [{ x: 1, y: 1, w: rows[0].length - 2, h: rows.length - 2 }]);
    const wide = (n) => ['#'.repeat(n), '#E' + '.'.repeat(n - 3) + '#', '#' + '.'.repeat(n - 2) + '#', '#' + '.'.repeat(n - 2) + '#', '#'.repeat(n)];
    const alerted = async (spotterChar, recvChar, recvPos, n = 40) => {
      const game = room(wide(n));
      game.pos = [1, 1];
      const spotter = adversary('a1', [6, 1], { character: spotterChar });
      const recv = adversary('a2', recvPos, { character: recvChar });
      game.adversaries = [spotter, recv];
      resetStub(game);
      const { events } = await step(game);
      return events.some((e) => e.type === 'alerted' && e.id === 'a2');
    };
    check(await alerted('standard', 'standard', [14, 3]), 'standard receiver hears a standard spotter');
    check(!(await alerted('territorial', 'standard', [14, 3])), 'a loner spotter does not call');
    check(!(await alerted('standard', 'territorial', [14, 3])), 'a loner far from the explorer does not answer a call');
    check(await alerted('standard', 'territorial', [4, 3]), 'a loner close to the explorer (<= 10 path steps) answers a call');
    check(!(await alerted('standard', 'short_sighted', [34, 3], 60)), 'a team-level receiver hears within 24 path steps only');
    check(await alerted('standard', 'patient_hunter', [34, 3], 60), 'a pack-level receiver hears within 40 path steps');
  }

  // Patrol territory: a homebody (roaming 1, 14 path steps) never leaves its room; a standard ghost roams everywhere.
  {
    const rows = ['#'.repeat(48), ...Array.from({ length: 5 }, (_, i) => '#' + '.'.repeat(7) + (i === 2 ? '.'.repeat(30) : '#'.repeat(30)) + '.'.repeat(7) + '#'), '#'.repeat(48)];
    const game = handMap(rows.map((r, y) => (y === 5 ? r.slice(0, 45) + 'E' + r.slice(46) : r)), [{ x: 1, y: 1, w: 7, h: 5 }, { x: 40, y: 1, w: 7, h: 5 }]);
    const home = adversary('a1', [3, 3], { character: 'territorial' }), roam = adversary('a2', [3, 3]);
    game.adversaries = [home, roam];
    resetStub(game);
    let homeMax = 0, roamMax = 0;
    for (let tick = 0; tick < 1500; tick++) {
      await step(game);
      homeMax = Math.max(homeMax, home.pos[0]);
      roamMax = Math.max(roamMax, roam.pos[0]);
      if (game.lost) break;
    }
    check(homeMax <= 8, `territorial ghost left its home room (x up to ${homeMax})`);
    check(roamMax >= 40, `standard ghost never reached the far room (x up to ${roamMax})`);
  }

  // State: self.character only for a non-standard ghost, in words; the six-key shape and memory stay valid.
  {
    const game = twoRooms();
    game.pos = [6, 1];
    const a = adversary('a1', [2, 1], { character: 'ambusher' }), b = adversary('a2', [2, 3]);
    game.adversaries = [a, b];
    resetStub(game);
    await step(game);
    await step(game); // a step needs 2 ticks of budget
    const call = (id) => stub.calls.find((c) => c.id === id);
    const ch = call('a1')?.state.self.character;
    check(ch && ch.id === 'ambusher' && typeof ch.style === 'string' && Object.values(ch.traits).every((w) => typeof w === 'string'), `self.character for ambusher: ${JSON.stringify(ch)}`);
    check(call('a2') && !('character' in call('a2').state.self), 'a standard ghost sends no self.character');
    check(JSON.stringify(Object.keys(a)) === '["id","pos","mode","budget","lastSeen","goal"]' && !JSON.stringify(a).includes('ambusher'), 'a character leaves the six-key shape alone');
    check(a.character === 'ambusher' && a.memory.character.id === 'ambusher', 'character accessor and memory.character');
    let threw = false;
    try { adversary('x', [1, 1], { character: 'nope' }); } catch { threw = true; }
    check(threw, 'unknown character id throws');
    const mem = createMemory('a9', 'timid');
    check(validateMemory(mem).character.id === 'timid', 'createMemory keeps the character');
    delete mem.character;
    let bad = false;
    try { validateMemory(mem); } catch { bad = true; }
    check(bad, 'validateMemory rejects a memory without a character');
    const ret = JSON.parse(a.lastRequestBody).questions;
    check(ret.next_move.instructions.priorities.length === 3 && ret.next_move.instructions.priorities[2].length <= 300, 'character priority line is the third next_move priority');
  }

  // The toggle: mixed characters at spawn, same dungeon and same ghost cells as with it off.
  {
    const d = generateDungeon(7);
    const off = spawnAdversaries(d);
    configureAdversaries({ adversaryCharacters: true });
    const on = spawnAdversaries(d);
    configureAdversaries({ adversaryCharacters: false });
    check(off.map((a) => a.pos.join()).join(';') === on.map((a) => a.pos.join()).join(';'), 'characters on/off: same ghost cells');
    check(off.every((a) => a.character === (kindOf(a.kind).character ?? 'standard')) && on.every((a) => kindOf(a.kind).character ? a.character === kindOf(a.kind).character : a.character !== 'standard'), 'toggle: old kinds standard/mixed, new kinds keep dedicated personalities');
  }
  console.log('characters: per-trait behaviour ok');
}

// 12. Smart memory (A3, adversaryCharacters on): sightings, recent path, landmarks, lifetime counters, team
//     reports. The helpers first, then a request through the stub, then the fog twin (full-map mode).
{
  const { addLandmark, addSighting, ageMemory, freshness, recordStep } = await import('../src/characters/adversary/memory.js');
  const { brainOn: memBrainOn, brainOff: memBrainOff } = await import('../src/characters/adversary/memory.js');
  const { profileOf, traitsOf } = await import('../src/characters/adversary/character.js');
  const prof = (id) => profileOf(traitsOf(id));
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };

  // Validation and caps.
  {
    const m = createMemory('a1');
    check(throws(() => addLandmark(m, { kind: 'chest', cell: [1, 1], tick: 1, note: 'x' }, 5)), 'landmark kind chest throws');
    m.landmarks.push({ kind: 'chest', cell: [1, 1], tick: 1, note: 'x' });
    check(throws(() => validateMemory(m)), 'validateMemory rejects a chest landmark');
    const k = createMemory('a2');
    addLandmark(k, { kind: 'home', cell: [1, 1], tick: 0, note: 'home' }, 3);
    for (let i = 0; i < 6; i++) addLandmark(k, { kind: 'explorer_lost', cell: [2 + i, 1], tick: i, note: 'lost' }, 3);
    check(k.landmarks.length === 3 && k.landmarks.some((l) => l.kind === 'home'), `landmark cap 3 keeps the pinned home (${k.landmarks.map((l) => l.kind)})`);
    addLandmark(k, { kind: 'explorer_lost', cell: [7, 1], tick: 9, note: 'again' }, 3);
    check(k.landmarks.filter((l) => l.kind === 'explorer_lost').length === 2, 'one landmark per kind + cell');
    validateMemory(k);
    const s = createMemory('a3');
    check(addSighting(s, { cell: [5, 5], tick: 1, heading: 'up', source: 'seen' }, 3), 'first sighting stored');
    check(!addSighting(s, { cell: [6, 5], tick: 2, heading: 'up', source: 'seen' }, 3), 'a sighting within 3 cells of the newest is not stored');
    for (const x of [9, 13, 17]) addSighting(s, { cell: [x, 5], tick: x, heading: 'right', source: 'called', by: 'a2' }, 3);
    check(s.sightings.length === 3 && s.sightings[0].cell[0] === 17 && s.sightings.at(-1).cell[0] === 9, 'sightings: newest first, capped at the character size');
    validateMemory(s);
    check(throws(() => { s.sightings[0].source = 'guessed'; validateMemory(s); }), 'validateMemory rejects an unknown sighting source');
  }

  // Decay: a short-term ghost forgets sooner; the pinned home never expires; words come from the age.
  {
    const short = prof('short_sighted'), long = prof('patient_hunter');
    const make = () => {
      const m = createMemory('a1');
      addLandmark(m, { kind: 'home', cell: [1, 1], tick: 0, note: 'home' }, 8);
      addLandmark(m, { kind: 'explorer_lost', cell: [4, 4], tick: 0, note: 'lost' }, 8);
      addSighting(m, { cell: [5, 5], tick: 0, heading: null, source: 'seen' }, 5);
      m.events.push({ tick: 0, text: 'First sighting' });
      return m;
    };
    const a = make(), b = make();
    ageMemory(a, 50, short);
    ageMemory(b, 50, long);
    check(a.sightings.length === 0 && a.landmarks.length === 1 && a.landmarks[0].kind === 'home' && a.events.length === 0, 'short-term ghost forgets sighting, landmark and event by tick 50 (home stays)');
    check(b.sightings.length === 1 && b.landmarks.length === 2 && b.events.length === 1, 'long-term ghost still remembers at tick 50');
    ageMemory(b, 400, long);
    check(b.sightings.length === 0 && b.landmarks.length === 1, 'long-term ghost forgets by tick 400');
    check(freshness(5, 30) === 'fresh' && freshness(15, 30) === 'stale' && freshness(25, 30) === 'cold', 'freshness words by fraction of ttl');
  }

  // Lifetime counters survive brainOn / brainOff; events survive when asked.
  {
    const m = createMemory('a1');
    memBrainOn(m, 5, 'first', { keepEvents: true });
    addEvent(m, 'First sighting', 5);
    memBrainOff(m, 20, 'timeout');
    memBrainOn(m, 30, 'second', { keepEvents: true });
    check(m.lifetime.hunts === 2 && m.lifetime.escapes === 1 && m.lifetime.last_hunt_end_tick === 20, `lifetime ${JSON.stringify(m.lifetime)}`);
    check(m.events.length === 1, 'events kept across hunts with smart memory');
    memBrainOn(m, 40, 'third');
    check(m.events.length === 0 && m.lifetime.hunts === 3, 'events cleared per hunt when smart memory is off');
  }

  // Ping-pong detection in the recent path.
  {
    const m = createMemory('a1');
    const w = { moves: 6, cells: 8 };
    recordStep(m, [1, 1], 'right', w);
    recordStep(m, [2, 1], 'right', w);
    check(recordStep(m, [1, 1], 'left', w) === true && m.recent.back_and_forth === 1, 'A -> B -> A counts as a ping-pong');
    for (let i = 0; i < 12; i++) recordStep(m, [i + 5, 1], 'right', w);
    check(m.recent.cells.length === 8 && m.recent.moves.length === 6, 'recent windows are capped');
    validateMemory(m);
  }

  configureAdversaries({ adversaryCharacters: true });
  try {
    // A request with smart memory: landmarks, sightings, team report, recent path and lifetime.
    {
      const game = twoRooms();
      game.pos = [6, 1];
      const a = adversary('a1', [2, 1], { character: 'patient_hunter' });
      const b = adversary('a2', [2, 5], { character: 'patient_hunter' });
      game.adversaries = [a, b];
      resetStub(game, { target: stayNearLastSeen });
      await step(game);
      game.pos = [14, 2];
      for (let t = 0; t < 8; t++) await step(game);
      const last = JSON.parse(a.lastRequestBody);
      const st = last.state;
      check(a.memory.sightings.length >= 1 && a.memory.sightings[0].source === 'seen', 'smart memory stored a sighting');
      check(st.surroundings.landmarks.some((l) => l.kind === 'home') && st.surroundings.landmarks.some((l) => l.kind === 'explorer_lost'), `landmarks in state: ${JSON.stringify(st.surroundings.landmarks)}`);
      check(st.explorer.in_sight === false && Array.isArray(st.explorer.sightings) && st.explorer.sightings[0].ticks_ago >= 1 && ['fresh', 'stale', 'cold'].includes(st.explorer.sightings[0].freshness), 'explorer.sightings with ticks_ago and a freshness word');
      check(st.recent.path && Array.isArray(st.recent.path.moves) && st.recent.lifetime.hunts === 1, 'recent.path and recent.lifetime in state');
      check(Array.isArray(st.team) && st.team.every((t) => t.id || t.others), 'team entries');
      check(!/chest|treasure/i.test(JSON.stringify({ ...st, game: null })), 'no chest or treasure in smart state');
      check(Buffer.byteLength(a.lastRequestBody) <= REQUEST_BYTES.adversaryMax, `smart request ${Buffer.byteLength(a.lastRequestBody)} bytes over the 8 KB budget`);
      validateMemory(a.memory);
      // A packmate's report reaches a ghost that can hear it.
      const call = stub.calls.filter((c) => c.id === 'a2').at(-1);
      const mate = call?.state.team.find((t) => t.id === 'a1');
      check(mate && mate.report && mate.report.source === 'called by a1' && mate.report.ticks_ago >= 1, `team report from a1 reaches a2: ${JSON.stringify(mate)}`);
    }

    // Fog twin, full-map mode with memory on: scramble the chest, the explorer's hidden position and
    // trail, its visit counts and a packmate out of hearing and out of view; requests stay identical.
    {
      async function run(hidden, trail, chest, visits, far) {
        const saved = Math.random;
        Math.random = rng(777);
        try {
          const game = twoRooms();
          game.pos = [6, 1];
          game.trail.push([5, 1], [6, 1]);
          const a = adversary('a1', [2, 1], { character: 'timid' }); // pack 1: hears within 8 path steps
          const far1 = adversary('a2', [15, 5]);
          const a2 = adversary('a3', far);
          game.adversaries = [a, far1, a2];
          resetStub(game, { target: stayNearLastSeen });
          await step(game);
          game.pos = [...hidden];
          game.trail.push(...trail);
          game.dungeon.treasure = chest;
          game.visits = visits;
          const from = stub.calls.length;
          for (let t = 0; t < 8; t++) await step(game);
          return stub.calls.slice(from).filter((c) => c.id === 'a1').map((c) => JSON.stringify(JSON.parse(c.body).state)); // state only: the far ghost's own calls shift the shared option shuffle
        } finally {
          Math.random = saved;
        }
      }
      const A = await run([14, 1], [[13, 1], [14, 1]], [15, 1], { '14,1': 9 }, [14, 5]);
      const B = await run([15, 3], [[15, 4], [15, 3]], [10, 5], { '1,1': 4 }, [11, 5]);
      check(A.length >= 2 && A.length === B.length, `memory twin: ${A.length} vs ${B.length} requests`);
      const bad = A.findIndex((state, i) => state !== B[i]);
      check(bad === -1, `memory twin: state ${bad} changed with the chest, hidden explorer, visits or a far packmate`);
    }
  } finally {
    configureAdversaries({ adversaryCharacters: false });
  }
  console.log('memory: helpers, state and fog twin ok');
}


// 13. Limited map (A4, limitedMap + adversaryCharacters on): the view's known set K, fog twins, forgetting.
//     A long corridor world; map B differs from map A only far from every ghost's K (a side room, a wall in
//     the corridor, the chest), so a ghost that reads nothing outside K sends byte-identical requests.
{
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  const limitedOn = () => configureAdversaries({ adversaryCharacters: true, limitedMap: true });
  const limitedOff = () => configureAdversaries({ adversaryCharacters: false, limitedMap: false });
  const W = 64;
  // x 1..62 corridor on y 1. A: side room x 50..60 (y 3..5) joined at x 52. B: another room x 54..60 joined at
  // x 56, a wall at (47, 1). The ghosts never get within 14 steps of x 45 and never see it.
  const worldRows = (variant, explorerAt) => {
    const r = Array.from({ length: 7 }, () => Array(W).fill('#'));
    for (let x = 1; x <= 62; x++) r[1][x] = '.';
    if (variant === 'A') { r[2][52] = '.'; for (let y = 3; y <= 5; y++) for (let x = 50; x <= 60; x++) r[y][x] = '.'; r[4][58] = 'T'; }
    else { r[1][47] = '#'; r[2][56] = '.'; for (let y = 3; y <= 5; y++) for (let x = 54; x <= 60; x++) r[y][x] = '.'; r[3][54] = 'T'; }
    r[explorerAt[1]][explorerAt[0]] = 'E';
    return r.map((row) => row.join(''));
  };
  const hiddenAt = { A: [45, 1], B: [43, 1] }; // corridor cells nobody sees
  const farAt = { A: [57, 4], B: [53, 3] };
  const pairs = (body) => [...body.matchAll(/\[(\d+),\s?(\d+)\]/g)].map((m) => `${m[1]},${m[2]}`);

  // One run of a scenario in map `variant`. Returns what the ghosts sent and where they were.
  async function limitedRun(variant, { ghosts, explorer, hideAt = null, ticks, far = true }) {
    const saved = Math.random;
    Math.random = rng(9191); // option shuffles: identical call order in both runs
    try {
      const game = handMap(worldRows(variant, explorer ?? hiddenAt[variant]), []);
      game.pos = [...(explorer ?? hiddenAt[variant])];
      game.adversaries = ghosts.map(([id, x, character]) => adversary(id, [x, 1], { character }));
      if (far) game.adversaries.push(adversary('a9', farAt[variant], { character: 'ambusher' }));
      resetStub(game, {});
      const log = { bodies: [], pos: [], known: new Map(), calls: stub.calls };
      for (let t = 0; t < ticks; t++) {
        if (t === hideAt) { game.pos = [...hiddenAt[variant]]; game.trail.push([hiddenAt[variant][0] - 1, hiddenAt[variant][1]], [...hiddenAt[variant]]); game.visits = { [hiddenAt[variant].join()]: 3 }; }
        await step(game);
        const mine = game.adversaries.filter((a) => a.id !== 'a9'); // the far ghost differs between the maps on purpose
        log.bodies.push(mine.map((a) => `${a.id}:${a.lastRequestBody}`).join('\n'));
        log.pos.push(mine.map((a) => a.pos.join()).join(' '));
        for (const a of mine) {
          const set = log.known.get(a.id) ?? log.known.set(a.id, new Set()).get(a.id);
          for (const k of adversaryView(game, a).knownKeys() ?? []) set.add(k);
        }
      }
      log.game = game;
      return log;
    } finally {
      Math.random = saved;
    }
  }

  limitedOn();
  try {
    // View API: K, hearing, frontier, kinds.
    {
      const game = handMap(worldRows('A', [30, 1]), []);
      const a1 = adversary('a1', [26, 1], { character: 'ambusher' }); // roaming 1: home radius 14
      const a2 = adversary('a2', [4, 1], { character: 'ambusher' });
      const a9 = adversary('a9', farAt.A, { character: 'ambusher' });
      game.adversaries = [a1, a2, a9];
      const v = adversaryView(game, a1), v2 = adversaryView(game, a2);
      check(v.mode === 'limited', 'limited: view mode');
      v.update(1);
      check(v.isKnown([12, 1]) && v.isKnown([40, 1]) && !v.isKnown([41, 1]) && !v.isKnown([11, 1]), 'limited: home zone is the cells within 14 path steps of the spawn cell');
      check(!v.isKnown([55, 4]) && v.distancesFrom([55, 4]).size === 0 && v.kindOf([55, 4]).kind === 'unknown', 'limited: a cell outside K reaches nothing and has no kind');
      check(!v.distancesFrom([26, 1]).has('41,1') && v.distancesFrom([26, 1]).has('40,1'), 'limited: BFS stays inside K');
      check(v.isKnownWall([30, 0]) && !v.isKnownWall([30, 3]) && !v.isKnownWall([45, 0]), 'limited: a wall is known only next to a known floor cell');
      check(v.teammateCount() === 2, `limited: teammateCount ${v.teammateCount()}`);
      check(!v.teammates().some((o) => o.id === 'a9'), 'limited: a packmate out of hearing and view is not listed');
      check(v2.legalMoves().join() === 'left,right', `limited: legal moves are the known neighbours (${v2.legalMoves()})`);
      v2.update(1);
      const edge = v2.frontierToward([32, 1]);
      check(edge && edge.cell.join() === '18,1' && edge.steps === 14, `limited: frontier toward an unknown target is the edge of the map (${JSON.stringify(edge)})`);
      check(v2.frontierToward([32, 1], v2.distancesFrom([40, 1])) === null, 'limited: no frontier from a cell outside K');
      // A call carries the caller's cells near the reported cell, not the real map.
      v2.hear(v, [30, 1], 1);
      check(v2.isKnown([30, 1]) && v2.isKnown([36, 1]) && v2.isKnown([24, 1]) && !v2.isKnown([37, 1]) && !v2.isKnown([20, 1]), 'limited: heard cells are the caller\'s cells within 6 steps of the reported cell');
      check(v2.frontierToward([32, 1]).cell.join() === '18,1', 'limited: a heard region with no route leaves the frontier where it was');
    }

    // Fading and the cap (short_sighted: horizon 1 -> ttl 40, cap 120; roaming 2 -> home radius 24).
    {
      const rows = ['#'.repeat(202), '#E' + '.'.repeat(199) + '#', '#'.repeat(202)];
      const game = handMap(rows, []);
      const a = adversary('a1', [2, 1], { character: 'short_sighted' });
      game.adversaries = [a];
      const v = adversaryView(game, a);
      v.update(1);
      check(v.isKnown([26, 1]) && !v.isKnown([60, 1]), 'fade: home zone is 24 steps around the spawn cell');
      a.pos = [60, 1];
      v.update(100);
      const nearby = v.knownCount();
      check(v.isKnown([62, 1]) && v.isKnown([66, 1]) && !v.isKnown([100, 1]), 'fade: a cell in view is known');
      a.pos = [2, 1];
      let gone = null;
      for (let t = 101; t <= 145; t++) {
        v.update(t);
        if (!v.isKnown([62, 1]) && gone === null) gone = t;
      }
      check(gone === 141, `fade: a cell stamped at tick 100 is forgotten after ttl 40, first missing at ${gone} (want 141)`);
      check(v.distancesFrom([2, 1]).has('62,1') === false && v.knownCount() < nearby, 'fade: a forgotten cell is gone from BFS and from the count');
      check(v.forgotten > 0, 'fade: forgotten counter');
      // Walk 150 cells: the seen set never exceeds the cap, the oldest cells are evicted, and stay out.
      const b = adversary('a2', [2, 1], { character: 'short_sighted' });
      game.adversaries = [b];
      const w = adversaryView(game, b);
      for (let x = 40; x <= 190; x++) { b.pos = [x, 1]; w.update(200 + (x - 40)); }
      const seenCount = w.knownKeys().filter((k) => Number(k.split(',')[0]) > 26).length;
      check(seenCount <= 120, `evict: seen cells ${seenCount} over the cap 120`);
      check(!w.isKnown([48, 1]), 'evict: an old cell was evicted');
      for (let t = 360; t < 366; t++) w.update(t);
      check(!w.isKnown([48, 1]), 'evict: an evicted cell stays out until it is seen again');
    }

    // Fog twins: map A vs map B, byte-identical requests, positions and nothing outside K mentioned.
    const scenarios = {
      patrol: { ghosts: [['a1', 26, 'ambusher'], ['a2', 4, 'ambusher']], ticks: 40 },
      chase: { ghosts: [['a1', 26, 'ambusher']], explorer: [30, 1], ticks: 8 },
      search: { ghosts: [['a1', 26, 'ambusher']], explorer: [30, 1], hideAt: 1, ticks: 14 },
      'alerted from far': { ghosts: [['a1', 26, 'ambusher'], ['a2', 4, 'ambusher']], explorer: [30, 1], hideAt: 1, ticks: 16 },
    };
    const runs = {};
    for (const [name, sc] of Object.entries(scenarios)) {
      const A = await limitedRun('A', sc), B = await limitedRun('B', sc);
      runs[name] = A;
      const diff = A.bodies.findIndex((b, i) => b !== B.bodies[i] || A.pos[i] !== B.pos[i]);
      check(diff === -1, `limited twin '${name}': requests or ghost positions changed with hidden state outside the known set (tick ${diff}: ${diff >= 0 ? A.pos[diff] + ' vs ' + B.pos[diff] : ''})`);
      const asked = A.bodies.filter((b) => b.includes('"state"')).length;
      if (name !== 'patrol') check(asked >= 2, `limited twin '${name}': only ${asked} ticks with a request`);
      else check(A.bodies.every((b) => b.split('\n').every((l) => l.endsWith(':null'))), 'limited twin patrol: a patrolling ghost sent a request');
      // No coordinate in any body names a cell outside the ghost's known set (the explorer's own cell excepted: it is in K when seen).
      let leak = null;
      for (const body of A.bodies) for (const line of body.split('\n')) {
        const id = line.slice(0, line.indexOf(':'));
        for (const c of pairs(line.slice(line.indexOf(':') + 1))) if (!A.known.get(id).has(c) && leak === null) leak = `${id} names ${c}`;
      }
      check(leak === null, `limited twin '${name}': ${leak} (outside its known set)`);
      check(![...A.bodies, ...B.bodies].some((b) => b.includes('[58,4]') || b.includes('[54,3]') || b.includes('[45,1]') || b.includes('[43,1]')), `limited twin '${name}': hidden explorer or chest coordinates in a request`);
    }
    {
      // The alerted ghost has no known route to the call: path_steps null, the edge of its map as the target.
      const bodies = runs['alerted from far'].bodies.map((b) => b.split('\n').find((l) => l.startsWith('a2:'))).filter((l) => l && l.includes('"state"')).map((l) => JSON.parse(l.slice(3)).state);
      check(bodies.some((s) => s.last_seen && s.last_seen.path_steps === null), 'alerted from far: last_seen has path_steps null (no known route)');
      check(bodies.some((s) => s.approach_target?.what?.includes('edge of what you know')), 'alerted from far: approach_target is the edge of what it knows');
      check(bodies.some((s) => /known: \d+ cells, home zone \+ seen/.test(s.surroundings.map_note ?? '')), 'alerted from far: map_note');
      check(bodies.every((s) => !/whole map/.test(s.game)) && /edge of what you know/.test(bodies[0].game), 'limited: the rules text has the fog line, not "whole map"');
      const last = runs['alerted from far'].game.adversaries.find((a) => a.id === 'a2');
      check(last.pos[0] > 4 || last.mode === 'patrol', 'alerted from far: the far ghost headed for the call or gave up');
    }
    // Full map (limitedMap off, characters on): the same far ghost has a route straight away.
    {
      limitedOff();
      configureAdversaries({ adversaryCharacters: true });
      const full = await limitedRun('A', scenarios['alerted from far']);
      const states = full.bodies.map((b) => b.split('\n').find((l) => l.startsWith('a2:'))).filter((l) => l && l.includes('"state"')).map((l) => JSON.parse(l.slice(3)).state);
      check(states.length && states.some((s) => s.last_seen && s.last_seen.path_steps !== null) && !states.some((s) => s.approach_target?.what?.includes('edge')), 'full map: the far ghost has a known route and no edge target');
      limitedOn();
      check(adversaryView(full.game, full.game.adversaries[0]).mode === 'full', 'full map: view mode stays full while the toggle was off at construction');
    }
    // limitedMap without the characters toggle does nothing.
    {
      configureAdversaries({ adversaryCharacters: false, limitedMap: true });
      const game = handMap(worldRows('A', [30, 1]), []);
      const a = adversary('a1', [26, 1]);
      game.adversaries = [a];
      check(adversaryView(game, a).mode === 'full', 'limitedMap alone (characters off) leaves the view in full mode');
      limitedOn();
    }
  } finally {
    limitedOff();
  }
  console.log('limited map: view, fading, cap, fog twins (patrol, chase, search, alerted from far) ok');
}

console.log(`largest ghost request: ${maxBody.bytes} bytes (questions ${maxBody.questions})`);
console.log(`CHASE_RANGE ${CHASE_RANGE}, SIGHT_RANGE ${SIGHT_RANGE}`);
if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log('all adversary checks passed');
