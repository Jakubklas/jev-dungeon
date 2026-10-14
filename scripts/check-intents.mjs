// Intent seams (PLAN-multiplayer-impl WP-B): decide() never mutates the Game; apply() re-validates against the
// current world (stale move / skill = no-op with a reason); takeTurn() == decide() + apply() + save(); the adversary
// tick split (beginAdversaryTick / decideAdversary / applyAdversaryResult) composes to stepAdversaries; the
// single-monster pair validates against the current state. All Jev calls are stubs; any network call fails the check.
// Run: JEV_CONFIG=none node scripts/check-intents.mjs
import { installTripwire } from './lib/tripwire.mjs';
installTripwire();
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newTestGame } from '../src/turn.js';
import { stepAdversaries, beginAdversaryTick, decideAdversary, applyAdversaryResult, monsterTurnStart, monsterTurnApply, CallAborted as AdvAborted } from '../src/characters/adversary/adversary.js';
import { CallAborted } from '../src/gateway/errors.js';
import { CallAborted as BrainAborted } from '../src/characters/explorer/brain.js';

const root = mkdtempSync(join(tmpdir(), 'jev-intents-check-'));
let n = 0;
let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('FAIL:', msg); } };

// Seeded Math.random: the option shuffle uses it, so two runs must start from the same state.
function seedRandom(seed) {
  let s = seed >>> 0;
  Math.random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const realRandom = Math.random;

function dirs() {
  const folder = join(root, String(++n));
  mkdirSync(folder);
  return pathToFileURL(folder + '/');
}

// A deterministic stub Jev: first option everywhere, except a strike whenever one is offered and the shield never.
function ask({ questions }) {
  return Object.fromEntries(Object.entries(questions).map(([key, q]) => {
    if (q.type === 'noul') return [key, { noul: key === 'directive_done' ? 0.1 : 0.9 }];
    const ids = Object.keys(q.criteria);
    let choice = ids[0];
    if (key === 'sentiment') choice = ids.includes('bold') ? 'bold' : ids[0];
    else if (key === 'tactic') choice = ids.includes('engage') ? 'engage' : ids[0];
    else if (key === 'skill') choice = ids.find((id) => id.startsWith('sword_strike')) ?? 'none';
    else if (key.startsWith('move_if_') || key === 'next_move') choice = ids.find((id) => id !== 'stay') ?? ids[0];
    return [key, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
  }));
}
// The monsters' stub: the first listed move; a claw strike whenever one is offered.
function decide({ questions }) {
  return Object.fromEntries(Object.entries(questions).map(([key, q]) => {
    if (q.type === 'noul') return [key, { noul: 0.9 }];
    const ids = Object.keys(q.criteria);
    const choice = key === 'skill' ? (ids.find((id) => id !== 'none') ?? 'none') : ids[0];
    return [key, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
  }));
}

function arena(extra = {}, opts = {}) {
  const d = dirs();
  return newTestGame({ size: '13x9', numAdversaries: 2, seed: 3, ...extra }, { ask, decide, memoryDir: d, dir: d, confidence: { fixedMood: true }, ...opts });
}
const ascii = (rows, extra = {}, opts = {}) => {
  const d = dirs();
  return newTestGame({ map: rows, ...extra }, { ask, decide, memoryDir: d, dir: d, confidence: { fixedMood: true }, ...opts });
};

// A structural fingerprint of everything decide() must leave alone (no Game clone: pick the fields).
function fingerprint(game) {
  return JSON.stringify({
    pos: game.pos, steps: game.steps, light: game.light, litOutside: [...game.litOutside], knownCount: game.knownCount,
    visits: game.visits, coins: game.coins, coinPiles: game.coinPiles, health: game.health, graceTicks: game.graceTicks,
    facing: game.facing, block: game.block, strikes: game.strikes, won: game.won, lost: game.lost,
    adversaries: game.adversaries, adversaryTicks: game.adversaryTicks, trail: game.trail,
  });
}

// apiMs is wall-clock time: it differs between two runs under load, so the comparison leaves it out.
const noTiming = (k, v) => (k === 'apiMs' ? undefined : v);

// ---- 1. decide() leaves the Game byte-identical; takeTurn == decide + apply + save over 30 ticks ----
async function lockstep(ticks, mk) {
  seedRandom(7);
  const a = mk();
  seedRandom(7);
  const b = mk();
  const out = { turnsA: [], turnsB: [], reqA: [], reqB: [], evA: [], evB: [], fp: true, intents: 0, strikes: 0, stale: 0 };
  for (let t = 0; t < ticks && !a.game.lost && !a.game.won; t++) {
    seedRandom(100 + t);
    a.game.clearTickState();
    const turnA = await a.explorer.takeTurn();
    out.reqA.push(a.explorer.lastRequests());
    out.evA.push(JSON.stringify((await stepAdversaries(a.game, { decide })).events));
    seedRandom(100 + t);
    b.game.clearTickState();
    const before = fingerprint(b.game);
    const { intent } = await b.explorer.decide();
    if (fingerprint(b.game) !== before) out.fp = false;
    if (JSON.stringify(intent) !== JSON.stringify(JSON.parse(JSON.stringify(intent)))) out.fp = false; // plain JSON
    out.intents++;
    const turnB = b.explorer.apply(intent);
    await b.explorer.save();
    out.reqB.push(b.explorer.lastRequests());
    out.evB.push(JSON.stringify((await stepAdversaries(b.game, { decide })).events));
    out.turnsA.push(JSON.stringify(turnA, noTiming));
    out.turnsB.push(JSON.stringify(turnB, noTiming));
    if (turnB.skill_decision?.used) out.strikes++;
    if (turnB.stale) out.stale++;
    if (fingerprint(a.game) !== fingerprint(b.game)) out.fp = 'diverged';
  }
  seedRandom(1);
  return out;
}
for (const [name, mk] of [
  ['open arena, 2 ghosts', () => arena({ numAdversaries: 2, minAdversaryGap: 3 })],
  ['ghost beside', () => ascii(['#########', '#.......#', '#..@A...#', '#.......#', '#...A...#', '#########'], { treasure: null })],
]) {
  const r = await lockstep(30, mk);
  ok(r.fp === true, `${name}: decide() left the Game alone and the intent is JSON (${r.fp})`);
  ok(r.turnsA.every((t, i) => t === r.turnsB[i]), `${name}: takeTurn turn objects == decide+apply over ${r.turnsA.length} ticks`);
  ok(r.reqA.every((t, i) => JSON.stringify(t) === JSON.stringify(r.reqB[i])), `${name}: request bodies equal`);
  ok(r.evA.every((t, i) => t === r.evB[i]), `${name}: adversary events equal`);
  ok(r.stale === 0, `${name}: nothing stale when the world did not change (${r.stale})`);
  ok(r.turnsA.length >= 5, `${name}: the run played ticks (${r.turnsA.length})`);
  if (name === 'ghost beside') ok(r.strikes > 0, `${name}: the run included explorer strikes (${r.strikes})`);
}

// ---- 2. a stale move is a no-op with a reason ----
{
  seedRandom(3);
  const run = arena({ numAdversaries: 0 });
  const { game, explorer } = run;
  game.clearTickState();
  const { intent } = await explorer.decide();
  ok(intent.kind === 'explorer' && typeof intent.move === 'string' && Number.isInteger(intent.distance), 'intent shape');
  // Wall off the cell the move leads to (a twin world event between decide and apply).
  const [x, y] = game.pos;
  const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[intent.move];
  if (d) {
    const row = game.dungeon.tiles[y + d[1]];
    game.dungeon.tiles[y + d[1]] = row.slice(0, x + d[0]) + '#' + row.slice(x + d[0] + 1);
    const steps = game.steps, pos = [...game.pos];
    const turn = explorer.apply(intent);
    ok(turn.stale?.some(([k]) => k === 'move'), `stale move reported (${JSON.stringify(turn.stale)})`);
    ok(game.steps === steps && game.pos[0] === pos[0] && game.pos[1] === pos[1], 'a stale move changes nothing in the world');
  } else {
    ok(false, `the stub chose a step (got ${intent.move})`);
  }
  let threw = false;
  try { explorer.apply(intent); } catch { threw = true; }
  ok(threw, 'apply() twice with one intent is refused');
}
{
  const run = arena({ numAdversaries: 0 });
  run.game.clearTickState();
  const { intent } = await run.explorer.decide();
  run.game.won = true; // the game ended between decide and apply
  const turn = run.explorer.apply(intent);
  ok(turn.stale?.some(([k, r]) => k === 'move' && r === 'game over'), 'a finished game makes the move stale (game over)');
}

// ---- 3. a stale sword misses a ghost that moved out of its cells ----
async function swordCase(moveGhost) {
  seedRandom(5);
  const run = ascii(['#########', '#.......#', '#..@A...#', '#.......#', '#########'], { treasure: null, numAdversaries: 1, ghostHp: 3 });
  const { game, explorer } = run;
  game.clearTickState();
  const ghost = game.adversaries[0];
  const { intent } = await explorer.decide();
  if (!intent.skill) return { noSkill: true };
  if (moveGhost) ghost.pos = [ghost.pos[0] + 1, ghost.pos[1] + 1]; // out of the struck cells, still in sight
  const hp = ghost.hp;
  const turn = explorer.apply(intent);
  return { intent, turn, hpLost: hp - ghost.hp, strikes: game.strikes.filter((s) => s.by === 'explorer').length };
}
{
  const hit = await swordCase(false);
  ok(!hit.noSkill && hit.intent.skill.startsWith('sword_strike') && hit.hpLost === 1 && !hit.turn.stale, `a fresh sword lands (skill ${hit.intent?.skill}, hp lost ${hit.hpLost}, stale ${JSON.stringify(hit.turn?.stale)})`);
  const miss = await swordCase(true);
  ok(!miss.noSkill && miss.hpLost === 0 && miss.strikes === 1, `a stale sword swings at the old cells and misses (hp lost ${miss.hpLost}, strikes ${miss.strikes})`);
  ok(miss.turn?.stale?.some(([k, r]) => k === 'skill' && r === 'swung at the old cells'), `the swing is reported stale (${JSON.stringify(miss.turn?.stale)})`);
  ok(miss.turn?.skill_decision?.used === miss.intent.skill, 'the skill decision says the sword was used');
  ok(BrainAborted === CallAborted && AdvAborted === CallAborted, 'one CallAborted class across gateway, explorer and adversary');
}

// ---- 4. abort: before and during a call; the next decide starts clean ----
{
  const ctl = new AbortController();
  ctl.abort();
  const run = arena({ numAdversaries: 0 });
  let err = null;
  try { await run.explorer.decide({ signal: ctl.signal }); } catch (e) { err = e; }
  ok(err instanceof CallAborted && err.name === 'CallAborted', 'an aborted signal rejects with CallAborted before any call');
  ok(run.explorer.lastRequests().length === 0, 'no Jev call was made after the abort');
}
{
  // Abort while the first call (the start sentiment) is in flight; then a normal decide equals a fresh brain's.
  seedRandom(11);
  const ctl = new AbortController();
  let calls = 0;
  const slowAsk = (a) => new Promise((resolve, reject) => {
    calls++;
    a.signal?.addEventListener('abort', () => reject(new Error('aborted by the caller')), { once: true });
    setTimeout(() => ctl.abort(), 5);
  });
  const d1 = dirs();
  const run = newTestGame({ size: '13x9', numAdversaries: 0, seed: 3 }, { ask: slowAsk, decide, memoryDir: d1, dir: d1, confidence: { fixedMood: true } });
  const fp = fingerprint(run.game);
  let err = null;
  try { await run.explorer.decide({ signal: ctl.signal }); } catch (e) { err = e; }
  ok(calls === 1 && err, `a call in flight is cut by the signal (calls ${calls}, error ${err?.name})`);
  ok(fingerprint(run.game) === fp, 'an aborted decide leaves the Game alone');
  // Replace the asker path: a second brain over a twin game answers normally; the aborted one, once given the same asker, must match it.
  seedRandom(11);
  const clean = arena({ numAdversaries: 0 });
  const cleanDecide = await clean.explorer.decide();
  seedRandom(11);
  const d2 = dirs();
  let phase = 0;
  const flaky = async (a) => { if (phase++ === 0) throw new Error('boom'); return ask(a); };
  const twin = newTestGame({ size: '13x9', numAdversaries: 0, seed: 3 }, { ask: flaky, decide, memoryDir: d2, dir: d2, confidence: { fixedMood: true } });
  let boom = null;
  try { await twin.explorer.decide(); } catch (e) { boom = e; }
  ok(boom?.message === 'boom', 'a rejecting call rejects decide');
  seedRandom(11);
  const again = await twin.explorer.decide();
  ok(JSON.stringify(again.intent) === JSON.stringify({ ...cleanDecide.intent, seq: again.intent.seq }), 'after a failed decide the next one starts clean (same intent as a fresh brain)');
  ok(JSON.stringify(twin.explorer.lastRequests()) === JSON.stringify(clean.explorer.lastRequests()), 'and sends the same requests (the start trigger was not lost)');
}

// ---- 5. adversary split == stepAdversaries ----
async function adversaryTicks(compose) {
  seedRandom(21);
  const run = arena({ numAdversaries: 3, minAdversaryGap: 3, size: '15x9' });
  const log = [];
  for (let t = 0; t < 50 && !run.game.lost; t++) {
    run.game.clearTickState();
    seedRandom(500 + t);
    run.game.applyMove(['right', 'left', 'down', 'up', 'stay'][t % 5]);
    seedRandom(900 + t);
    const r = await compose(run.game);
    log.push(JSON.stringify([r.events, r.turns, fingerprint(run.game), run.game.adversaries.map((a) => a.hunt.on)], (k, v) => (k === 'apiMs' ? 0 : v)));
  }
  return log;
}
{
  const whole = await adversaryTicks((g) => stepAdversaries(g, { decide }));
  const split = await adversaryTicks(async (g) => {
    const { ctx, thinkers } = beginAdversaryTick(g);
    if (ctx.over) return { events: ctx.events, turns: ctx.turns };
    const results = new Map();
    const pending = thinkers.map((a) => decideAdversary(g, a, ctx, { decide }).then((r) => results.set(a, r)));
    await Promise.all(pending);
    for (const a of ctx.order) if (applyAdversaryResult(g, a, ctx, results.get(a)).lost) break;
    return { events: ctx.events, turns: ctx.turns };
  });
  ok(whole.length === split.length && whole.every((l, i) => l === split[i]), `adversary split == stepAdversaries over ${whole.length} ticks`);
  ok(whole.length >= 20, 'the adversary run played ticks');
  const sawHunt = whole.some((l) => l.includes('"brain":"on"'));
  ok(sawHunt, 'at least one ghost hunted during the run');
}
{
  const ctl = new AbortController();
  ctl.abort();
  const run = arena({ numAdversaries: 1 });
  const { ctx, thinkers } = beginAdversaryTick(run.game);
  let err = null;
  try { await decideAdversary(run.game, run.game.adversaries[0], ctx, { decide, signal: ctl.signal }); } catch (e) { err = e; }
  ok(err instanceof AdvAborted && err.name === 'CallAborted', `decideAdversary rejects with CallAborted when aborted (thinkers ${thinkers.length})`);
}
{
  // The request is built before the first await: ghosts started in id order record their body in id order.
  const run = ascii(['###########', '#.........#', '#.@.A.A...#', '#.........#', '###########'], { treasure: null });
  for (const g of run.game.adversaries) g.budget = 1; // act on the first tick
  const { ctx, thinkers } = beginAdversaryTick(run.game);
  const order = [];
  const probe = (req) => { order.push(req.id); return decide(req); };
  const ps = thinkers.map((a) => decideAdversary(run.game, a, ctx, { decide: probe }));
  ok(thinkers.length === 2, "both ghosts think");
  const lens = thinkers.map((a) => a.lastRequestBody != null);
  ok(lens.every(Boolean), 'every ghost built its request body synchronously, before any await');
  await Promise.all(ps);
  ok(order.join() === thinkers.map((a) => a.id).join(), `calls went out in id order (${order.join()})`);
}

// ---- 6. the single-monster pair ----
function hunt(extra = {}) {
  const run = ascii(['#########', '#.......#', '#..@A...#', '#.......#', '#########'], { treasure: null, numAdversaries: 1, ghostHp: 3, ...extra });
  return { run, game: run.game, ghost: run.game.adversaries[0] };
}
{
  // a claw hits whoever stands in its cells at apply time
  seedRandom(2);
  const { game, ghost } = hunt();
  const start = monsterTurnStart(game, ghost, { now: 1 });
  ok(start && ghost.hunt.on, 'monsterTurnStart senses the explorer and turns the brain on');
  const res = await decideAdversary(game, ghost, start, { decide });
  ok(res.skill && res.skill !== 'none', `the stub asked for a claw (${res.skill})`);
  const hp = game.health;
  const out = monsterTurnApply(game, ghost, start, res);
  ok(game.health < hp && out.events.some((e) => e.type === 'hit'), `the claw hit the explorer where it stood (${hp} -> ${game.health})`);
}
{
  // the explorer stepped away between start and apply: the claw lands on nobody
  seedRandom(2);
  const { game, ghost } = hunt();
  const start = monsterTurnStart(game, ghost, { now: 1 });
  const res = await decideAdversary(game, ghost, start, { decide });
  game.pos = [6, 3];
  const hp = game.health;
  const out = monsterTurnApply(game, ghost, start, res);
  ok(game.health === hp && !out.events.some((e) => e.type === 'hit'), 'a claw whose target left hits nobody');
}
{
  // a step that is no longer legal is a no-op; a dispelled monster does nothing; a stunned one does nothing
  seedRandom(2);
  const { game, ghost } = hunt();
  const start = monsterTurnStart(game, ghost, { now: 1 });
  const res = { dir: 'up', decision: null, keep_hunting: null, approach: null, forced: true, apiMs: 0, error: null, skill: 'none', skill_decision: null };
  game.dungeon.tiles[ghost.pos[1] - 1] = '#########';
  const at = [...ghost.pos];
  const out = monsterTurnApply(game, ghost, start, res);
  ok(out.stale?.includes('step no longer legal') && ghost.pos[0] === at[0] && ghost.pos[1] === at[1], `an illegal stale step is a no-op (${JSON.stringify(out.stale)})`);
  const again = hunt();
  const s2 = monsterTurnStart(again.game, again.ghost, { now: 1 });
  again.game.adversaries = again.game.adversaries.filter((x) => x !== again.ghost);
  ok(monsterTurnApply(again.game, again.ghost, s2, null).stale?.includes('dispelled'), 'a dispelled monster does nothing');
  const third = hunt();
  const s3 = monsterTurnStart(third.game, third.ghost, { now: 1 });
  third.ghost.takeHit(1, [third.ghost.pos[0] - 1, third.ghost.pos[1]]); // a non-lethal blow (hp 3) stuns
  const stunned = third.game.adversaries.includes(third.ghost) && third.ghost.stun > 0;
  if (stunned) ok(monsterTurnApply(third.game, third.ghost, s3, null).stale?.includes('stunned'), 'a monster stunned since the start does nothing');
  ok(monsterTurnStart(hunt().game, { id: 'zz' }, { now: 1 }) === null, 'a monster that is not in the game has no turn');
}
{
  // brain off: start has no thinker, apply patrols
  seedRandom(2);
  const run = ascii(['###############', '#.............#', '#@............#', '#.............#', '#############A#'.replace('A', '#'), '###############'].slice(0, 5), { treasure: null, numAdversaries: 0, adversaries: [[13, 3]] });
  const ghost = run.game.adversaries[0];
  const start = monsterTurnStart(run.game, ghost, { now: 1 });
  ok(start && !start.thinks, 'a patrolling monster has nothing to ask');
  const out = monsterTurnApply(run.game, ghost, start, undefined);
  ok(out.turn.brain === 'off' && !out.lost, 'a patrol turn applies');
}

rmSync(root, { recursive: true, force: true });
Math.random = realRandom;
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all intent checks passed');
