// Checks for the world clock (PLAN-multiplayer WP-D): game.clock / game.rules (stepMs, cadenceMs), Run.playTurn adding one
// stepMs per turn, shared timers as deadlines on that clock (grace, shield stance, stun, heart respawn, regen, explorer
// skill cooldowns), the derived durations, equivalence with the old step behaviour over >= 100 stubbed ticks, a monster
// hit at a non-step time, freeze/thaw and independent grace for two explorers. Free, no Jev (fetch tripwire).
import { installTripwire } from './lib/tripwire.mjs';
installTripwire();
import { readFileSync } from 'node:fs';
import { Game, STAY, STEP_MS, CADENCE_MS, HEART_RESPAWN, REGEN_STEPS, configureWorld } from '../src/dungeon.js';
import { buildArena } from '../src/testbed.js';
import { newTestGame } from '../src/turn.js';
import { GRACE_TICKS, Adversary, stepAdversaries, monsterTurnStart, monsterTurnApply, decideAdversary, graceLeft, moveIntervalMs, ADVERSARY_SPEED } from '../src/characters/adversary/adversary.js';
import { buildSkillSet } from '../src/skills/loadouts.js';
import { AttackSkill } from '../src/skills/attack.js';
import { DashSkill } from '../src/skills/dash.js';
import { playDuel, clawDecide } from './lib/duel-harness.mjs';
import { KNOBS } from '../src/config/registry.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(`FAIL: ${m}`); } };
const S = STEP_MS;

// ---- 1. the knobs and the derived durations
{
  const k = (key) => KNOBS.find((x) => x.key === key);
  ok(k('stepMs')?.def === 400 && k('cadenceMs')?.def === 90 && k('stepMs').when === 'next' && k('stepMs').page === false, 'registry: rules.stepMs 400, rules.cadenceMs 90, file-only, next game');
  ok(k('stepMs').path === 'rules.stepMs' && k('cadenceMs').path === 'rules.cadenceMs', 'registry paths');
  ok(STEP_MS === 400 && CADENCE_MS === 90, 'dungeon.js defaults');
  ok(GRACE_TICKS * S === 1600, `grace 4 steps = 1600 ms (${GRACE_TICKS * S})`);
  ok(HEART_RESPAWN * S === 80000, `heart respawn 200 steps = 80 s (${HEART_RESPAWN * S})`);
  ok(REGEN_STEPS * S === 12000, `regen every 30 steps = 12 s (${REGEN_STEPS * S})`);
  const doc = readFileSync(new URL('../CONFIG.md', import.meta.url), 'utf8');
  ok(/grace 4 steps = 1\.6 s/.test(doc) && /heart respawn 200 steps = 80 s/.test(doc), 'CONFIG.md documents the derived durations');
  const g = new Game(buildArena({ size: [5, 5], numAdversaries: 0 }).dungeon);
  ok(g.clock === 0 && g.rules.stepMs === 400 && g.rules.cadenceMs === 90 && g.worldTick() === 0, 'a new game: clock 0, rules from the knobs');
  configureWorld({ stepMs: 250, cadenceMs: 30 });
  const g2 = new Game(buildArena({ size: [5, 5], numAdversaries: 0 }).dungeon);
  ok(g2.rules.stepMs === 250 && g2.rules.cadenceMs === 30, 'configureWorld sets the next game\'s rules');
  ok(g.rules.stepMs === 400, 'a running game keeps the rules it started with');
  configureWorld({ stepMs: 400, cadenceMs: 90 });
}

// ---- 2. Run adds exactly one stepMs per turn
const noopAsk = async ({ questions }) => {
  const out = {};
  for (const [key, q] of Object.entries(questions)) {
    if (q.type === 'noul') { out[key] = { noul: 0.1 }; continue; }
    const keys = Object.keys(q.criteria);
    const pick = key === 'skill' ? 'none' : key === 'sentiment' ? (keys.includes('steady') ? 'steady' : keys[0]) : (keys.includes('stay') ? 'stay' : keys[0]);
    out[key] = { choice: pick, probabilities: { [pick]: 1 }, confidence: 1 };
  }
  return out;
};
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const dirUrl = pathToFileURL(mkdtempSync(join(tmpdir(), 'jev-clock-')) + '/');
{
  const run = newTestGame({ size: [9, 9], numAdversaries: 0, treasure: null }, { ask: noopAsk, decide: clawDecide, dir: dirUrl, memoryDir: dirUrl });
  ok(run.game.clock === 0, 'Run starts at clock 0');
  for (let t = 1; t <= 12; t++) {
    await run.playTurn();
    if (run.game.clock !== t * S || run.game.worldTick() !== t) { ok(false, `turn ${t}: clock ${run.game.clock} tick ${run.game.worldTick()}`); break; }
  }
  ok(run.game.clock === 12 * S, 'after 12 turns the clock reads 12 steps');
  run.game.freeze();
  await run.playTurn();
  ok(run.game.clock === 12 * S, 'a frozen game does not advance in a turn');
  run.game.thaw();
}

// ---- 3. equivalence with the step path: grace, regen over >= 100 stubbed ticks
for (const [name, opts] of [
  ['open room, hp 3 ghost', { room: 'open', ghostHp: 3 }],
  ['corridor', { room: 'corridor', ghostHp: 3 }],
  ['dead end', { room: 'deadend', ghostHp: 3 }],
]) {
  let lastHit = null, bad = 0, hits = [], regenAt = [], prevHealth = null, clockBad = 0, invBad = 0;
  const r = await playDuel({
    ...opts, policy: 'walk-in', skills: 'none', health: 99, seed: 5, maxTicks: 130,
    settings: { clawCooldown: 1 },
    onTurn: (turn, game, run) => {
      const t = run.game.worldTick();
      if (game.clock !== t * S) clockBad++;
      if (turn.events.some((e) => e.type === 'hit')) { lastHit = t; hits.push(t); }
      const want = lastHit === null ? 0 : Math.max(0, GRACE_TICKS - (t - lastHit));
      if (game.graceLeftSteps() !== want || game.graceTicks !== want || graceLeft(game) !== want) bad++;
      if ((run.view().grace_ticks > 0) !== (want > 0) || run.view().invulnerable !== (want > 0)) invBad++;
      if (turn.events.some((e) => e.type === 'regen')) regenAt.push(t);
    },
  });
  ok(r.ticks >= 100, `${name}: played ${r.ticks} ticks`);
  ok(hits.length >= 2, `${name}: the explorer was hit ${hits.length} times (grace is exercised)`);
  ok(bad === 0 && clockBad === 0 && invBad === 0, `${name}: grace reads like the old countdown every tick (${bad} / clock ${clockBad} / view ${invBad})`);
  ok(hits.every((h, i) => i === 0 || h - hits[i - 1] >= GRACE_TICKS + 1), `${name}: no hit inside the grace window (${hits.join(',')})`);
  // The first hit after a window can come the very tick it ends (window = 4 following ticks).
  ok(hits.some((h, i) => i > 0 && h - hits[i - 1] === GRACE_TICKS + 1), `${name}: a claw lands the first tick after the window (${hits.join(',')})`);
  ok(regenAt.every((t) => t % REGEN_STEPS === 0), `${name}: regen only at multiples of 30 steps (${regenAt.join(',')})`);
  ok(regenAt.length >= 3, `${name}: regen happened ${regenAt.length} times`);
}

// Regen and hearts on a plain Run: stay for 100 turns.
{
  const run = newTestGame({ size: [9, 9], numAdversaries: 0, treasure: null }, { ask: noopAsk, decide: clawDecide, dir: dirUrl, memoryDir: dirUrl });
  run.game.health = 1;
  const at = [];
  for (let t = 1; t <= 105; t++) { const turn = await run.playTurn(); for (const e of turn.events) if (e.type === 'regen') at.push([t, e.health]); }
  ok(JSON.stringify(at) === JSON.stringify([[30, 1.5], [60, 2], [90, 2.5]]), `regen through Run: every 30 turns (${JSON.stringify(at)})`);
}

// ---- 4. managed clock: deadlines are ms, not steps
{
  const mk = (extra = {}) => { const g = new Game(buildArena({ size: [9, 9], numAdversaries: 0, treasure: null, ...extra }).dungeon); g.managed = true; return g; };
  // grace
  let g = mk();
  g.clock = 1234;
  g.setGrace(null, GRACE_TICKS);
  const until = g.explorers[0].graceUntil;
  ok(until === 1234 + 1600, `grace deadline = clock + 1600 (${until})`);
  g.clock = until; ok(g.graceActive(null) === true, 'protected at the last instant of the window');
  g.clock = until + 1; ok(g.graceActive(null) === false, 'not protected 1 ms later');
  g.clock = 1234 + 799; ok(g.graceLeftSteps() === 3, `799 ms in (801 ms left): ${g.graceLeftSteps()} steps left (ceil)`);
  // block stance
  g = mk();
  g.clock = 5000;
  g.explorers[0].block = { effectiveness: 1, until: 5000 + S };
  g.clock = 5000 + S; ok(g.blockActive(null), 'block holds to the deadline');
  g.clearTickState(); ok(g.explorers[0].block !== null, 'clearTickState keeps a block at its deadline');
  g.clock = 5000 + S + 1; g.clearTickState(); ok(g.explorers[0].block === null, 'clearTickState drops it 1 ms after');
  // stun
  g = mk();
  const a = new Adversary({ id: 'a1', pos: [3, 3], hp: 3 });
  g.adversaries = [a];
  g.clock = 1000;
  a.takeHit(1, [2, 3], g);
  ok(a.stunnedAt(g), 'stunned after a hit');
  g.clock = 1000 + 2 * S - 1; ok(a.tickStun(g) === true, 'still stunned 1 ms before the deadline');
  g.clock = 1000 + 2 * S; ok(a.tickStun(g) === false && !a.stunnedAt(g) && a.stun === 0, 'free at the deadline');
  // regen is one chance per period of world time, whatever the step count
  g = mk(); g.explorers[0].health = 1;
  g.clock = 11999; ok(g.applyMove(STAY).regen === 0, 'regen: not before 12 s');
  g.clock = 12000; ok(g.applyMove(STAY).regen === 0.5 && g.health === 1.5, 'regen: half a life at 12 s of world time (second step)');
  g.clock = 12500; ok(g.applyMove(STAY).regen === 0, 'regen: once per period');
  g.clock = 30000; ok(g.applyMove(STAY).regen === 0.5, 'regen: a long gap gives one heal, not a backlog');
  // heart respawn on the clock
  configureWorld({ heartRespawn: 5 });
  g = mk({ hearts: [[6, 5]], start: [5, 5] });
  g.health = 1; g.maxHealth = 3;
  g.clock = 1000;
  g.applyMove('right');
  ok(g.heartsTaken.length === 1 && g.heartsTaken[0].due === 1000 + 5 * S, `heart due = clock + 2000 (${JSON.stringify(g.heartsTaken)})`);
  g.clock = 2999; g.applyMove('right'); ok(g.heartPiles.length === 0, 'heart still gone 1 ms early (steps do not matter)');
  g.clock = 3000; const back = g.applyMove('right');
  ok(back.respawned === 1 && g.heartPiles.length === 1, 'heart back at the deadline');
  configureWorld({ heartRespawn: 200 });
  // explorer skill cooldown on the managed clock
  const set = buildSkillSet(['sword_strike', 'shield_block']);
  g = mk(); g.clock = 0;
  set.attachTime(() => g.timeOf(null), S);
  const sword = set.skills[0], shield = set.skills[1];
  g.clock = 700; sword.markUsed(3); shield.markUsed(3);
  ok(!sword.ready && sword.cooldownLeft === 1 && shield.cooldownLeft === 2, `skills: cooldown_left is a step count (${sword.cooldownLeft}, ${shield.cooldownLeft})`);
  g.clock = 1099; ok(!sword.ready && sword.summary().cooldown_left === 1, 'sword not ready 1 ms early');
  g.clock = 1100; ok(sword.ready && !shield.ready && shield.summary().cooldown_left === 1, 'sword ready at 400 ms, shield (2 steps) at 800');
  g.clock = 1500; ok(shield.ready, 'shield ready at 800 ms');
  sword.turnPassed(); ok(sword.ready, 'turnPassed does nothing once a time source is attached');
}

// ---- 5. skill cooldowns: the attached deadline equals the old turn counter (random use over 200 turns)
{
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  for (const cooldown of [1, 2, 3, 7]) {
    const mk = () => new AttackSkill({ id: 's', name: 's', cooldown, shape: [[1, 0]], damage: 1 });
    const legacy = mk(), timed = mk();
    let turn = 0;
    timed.attachTime(() => turn * S, S); // the explorer's own time: steps taken so far
    let diff = 0, uses = 0;
    for (let k = 1; k <= 200; k++) {
      if (legacy.ready !== timed.ready || legacy.cooldownLeft !== timed.cooldownLeft) diff++;
      if (legacy.ready && rnd() < 0.7) { legacy.markUsed(k); timed.markUsed(k); uses++; if (legacy.cooldownLeft !== timed.cooldownLeft) diff++; }
      legacy.turnPassed();
      turn = k; // the step is taken
    }
    ok(diff === 0 && uses > 20, `skill cooldown ${cooldown}: identical to the turn counter over 200 turns (${uses} uses, ${diff} differences)`);
  }
  // Dash keeps its real clock unless given one
  let now = 10000;
  const dash = new DashSkill({ id: 'dash', name: 'Dash', cooldown: 20, distance: 4, now: () => now });
  dash.attachTime(() => 0, S);
  dash.markUsed(1);
  ok(!dash.ready && dash.cooldownLeft === 20, 'Dash ignores the step time source');
  let world = 0;
  dash.attachClock(() => world);
  dash.markUsed(2); world = 19999; ok(!dash.ready, 'Dash follows an attached game clock (ms): not ready at 19.999 s');
  world = 20000; ok(dash.ready, 'Dash ready at 20 s of world time');
}

// ---- 6. a monster claw at a time that is not a step multiple
{
  const run = newTestGame({ map: ['#######', '#.....#', '#.@.A.#', '#.....#', '#######'], treasure: null }, { ask: noopAsk, decide: clawDecide, dir: dirUrl, memoryDir: dirUrl });
  const game = run.game;
  game.managed = true;
  const a = game.adversaries[0];
  a.pos = [3, 2]; // next to the explorer at [2,2]
  a.mode = 'chase';
  game.clock = 777;
  a.budget = 1;
  const start = monsterTurnStart(game, a);
  ok(start && start.tick === game.worldTick(), `monster ages by the clock's tick (${start?.tick} vs ${game.worldTick()})`);
  const res = await decideAdversary(game, a, start, { decide: clawDecide });
  const done = monsterTurnApply(game, a, start, res);
  const hit = done.events.find((e) => e.type === 'hit');
  ok(!!hit, `the claw hit at clock 777 (${done.events.map((e) => e.type)})`);
  ok(game.explorers[0].graceUntil === 777 + GRACE_TICKS * S, `grace deadline 777 + 1600 (${game.explorers[0].graceUntil})`);
  // 1601 ms later the next claw may land; 1599 ms later it may not
  const clawAt = async (clock) => {
    const gm = newTestGame({ map: ['#######', '#.....#', '#.@.A.#', '#.....#', '#######'], treasure: null }, { ask: noopAsk, decide: clawDecide, dir: dirUrl, memoryDir: dirUrl }).game;
    gm.managed = true; gm.health = gm.maxHealth = 9;
    const m = gm.adversaries[0]; m.pos = [3, 2]; m.mode = 'chase';
    gm.clock = 777; m.budget = 1;
    let s = monsterTurnStart(gm, m);
    monsterTurnApply(gm, m, s, await decideAdversary(gm, m, s, { decide: clawDecide }));
    gm.clock = clock; m.budget = 1;
    for (const sk of m.skills.skills) while (!sk.ready) sk.turnPassed(); // the claw's own recharge is its own turns
    m.pos = [3, 2];
    s = monsterTurnStart(gm, m);
    const r = s ? monsterTurnApply(gm, m, s, await decideAdversary(gm, m, s, { decide: clawDecide })) : { events: [] };
    return r.events.some((e) => e.type === 'hit');
  };
  ok(await clawAt(777 + 1599) === false, 'a claw 1599 ms after a hit is shrugged off (grace)');
  ok(await clawAt(777 + 1600) === false, 'a claw exactly at the end of the window is still protected (inclusive, like the old 4th tick)');
  ok(await clawAt(777 + 1601) === true, 'a claw 1601 ms after a hit lands');
  // movement interval helper
  ok(Math.abs(moveIntervalMs(game, a) - 400 / (ADVERSARY_SPEED * a.speed)) < 1e-9 && Math.round(moveIntervalMs(game, a)) === 667, `moveIntervalMs = stepMs / speed (${moveIntervalMs(game, a)})`);
}

// ---- 7. freeze / thaw keeps the remaining durations
{
  const g = new Game(buildArena({ size: [9, 9], numAdversaries: 0, treasure: null }).dungeon);
  g.managed = true;
  g.clock = 10000;
  g.setGrace(null, 4);
  g.explorers[0].block = { effectiveness: 0.6, until: 10000 + S };
  const a = new Adversary({ id: 'a1', pos: [3, 3], hp: 3 });
  g.adversaries = [a];
  a.takeHit(1, [2, 3], g);
  const set = buildSkillSet(['sword_strike']);
  set.attachTime(() => g.timeOf(null), S);
  set.skills[0].markUsed(1);
  g.clock = 10100;
  const left = g.freeze();
  ok(left.explorers.explorer.grace === 1500 && left.explorers.explorer.block === 300, `remaining at the pause: grace ${left.explorers.explorer.grace}, block ${left.explorers.explorer.block}`);
  g.advance(60000); g.setClock(999999);
  ok(g.clock === 10100, 'a frozen clock does not move');
  ok(g.graceActive(null) && g.graceLeftSteps() === 4 && g.blockActive(null) && a.stunnedAt(g) && !set.skills[0].ready && set.skills[0].cooldownLeft === 1, 'a minute of pause changed no deadline');
  g.thaw();
  g.advance(300);
  ok(g.graceLeftSteps() === 3 && Math.round(g.explorers[0].graceUntil - g.clock) === 1200, `after the resume 300 ms came off the grace (${g.explorers[0].graceUntil - g.clock})`);
  g.advance(100);
  ok(!g.blockActive(null) && set.skills[0].ready, 'block and sword ran out on the resumed clock');
  g.advance(900);
  ok(!a.stunnedAt(g) && a.tickStun(g) === false, 'stun ran out after 800 ms of running time in total');
  // Run.playTurn on a frozen game does not move the clock (checked in section 2); a thawed one does
}

// ---- 8. two explorers, independent grace and regen
{
  const g = new Game(buildArena({ size: [9, 9], numAdversaries: 0, treasure: null }).dungeon, { explorers: [{ id: 'a', start: [3, 3] }, { id: 'b', start: [6, 6] }] });
  g.setGrace('b', 2);
  ok(g.graceLeftSteps('b') === 2 && g.graceLeftSteps('a') === 0 && graceLeft(g, 'b') === 2, 'grace is per explorer');
  const seen = [];
  for (let i = 0; i < 4; i++) { await stepAdversaries(g, { decide: async () => ({}) }); seen.push([g.graceLeftSteps('a'), g.graceLeftSteps('b')]); }
  ok(JSON.stringify(seen) === JSON.stringify([[0, 1], [0, 0], [0, 0], [0, 0]]), `b's grace counts down alone (${JSON.stringify(seen)})`);
  ok(g.graceActive('b', 1 * S) && g.graceActive('b', 2 * S) && !g.graceActive('b', 2 * S + 1) && !g.graceActive('a', 1 * S), 'each explorer has its own deadline');
  // managed: each explorer's regen runs on the shared clock but is checked per explorer
  const m = new Game(buildArena({ size: [9, 9], numAdversaries: 0, treasure: null }).dungeon, { explorers: [{ id: 'a', start: [3, 3] }, { id: 'b', start: [6, 6] }] });
  m.managed = true;
  m.explorer('a').health = 1; m.explorer('b').health = 1;
  m.clock = 12000;
  ok(m.applyMove(STAY, 1, 'a').regen === 0.5 && m.explorer('b').health === 1, 'regen: a healed, b has not moved yet');
  ok(m.applyMove(STAY, 1, 'b').regen === 0.5 && m.explorer('a').health === 1.5, 'regen: b heals on its own step');
  m.setGrace('a', 4); m.clock = 12000 + 1000;
  ok(m.graceActive('a') && !m.graceActive('b'), 'managed: a protected, b not');
}

console.log(fails ? `${fails} FAIL(S)` : 'check-clock: ok');
process.exit(fails ? 1 : 0);
