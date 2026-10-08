// Checks for the confidence model's wiring in the brain (PLAN-confidence C2): the REAL ExplorerBrain through
// newTestGame with the `confidence` option, stub Jev, throwing fetch tripwire (the duel harness installs it).
// Event table: each event moves C by the documented delta (strike +6, dispel +12, hit -15 then the lives cap,
// blocked +3 up to 65, evaded +4 up to 65 only for an encounter with a chasing sighting and no hit and no
// dispel, pressed -2 at most -8 per encounter (never for a ghost the own strike stunned), blocked events forwarded by Run, calm +0.3 only below 50), memory shape with the toggle on and
// off, the turn's `confidence` object, and a fog twin (a hidden ghost in another room changes nothing).
// Requests stay byte-identical with the toggle on (C2 changes no request text): scripts/check-request-hashes.mjs.
// Free, no Jev.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clawDecide, mulberry32 } from './lib/duel-harness.mjs'; // installs the fetch tripwire
import { newTestGame } from '../src/turn.js';
import { validateMemory, renderMarkdown } from '../src/characters/explorer/memory.js';
import { configureSkills, skillConfig } from '../src/skills/config.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(`FAIL: ${m}`); } };
const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });
const dir = mkdtempSync(join(tmpdir(), 'jev-confwire-'));
const url = pathToFileURL(dir + '/');

// A scripted Jev: a fixed mood, `tactic` when offered (else the first), a skill when `skill`, moves from the facts.
const stub = ({ mood = 'steady', tactic = 'run_away', skill = false } = {}) => async ({ questions }) => {
  const out = {};
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === 'noul') { out[k] = { noul: k === 'leave_now' ? 0.1 : 0.9 }; continue; }
    const keys = Object.keys(q.criteria);
    if (k === 'sentiment') out[k] = answer(keys.includes(mood) ? mood : keys[0]);
    else if (k === 'tactic') out[k] = answer(keys.includes(tactic) ? tactic : keys[0]);
    else if (k === 'skill') out[k] = answer(skill ? keys.find((x) => x !== 'none') ?? 'none' : 'none');
    else if (k === 'next_move' || k.startsWith('move_if_')) {
      const moves = keys.filter((d) => d !== 'stay');
      out[k] = answer(moves.find((d) => /Reaches the target/.test(q.criteria[d])) ?? moves.find((d) => /Closer to the target/.test(q.criteria[d])) ?? moves[0] ?? 'stay');
    } else out[k] = answer(keys[0]);
  }
  return out;
};

const ROOM = ['###############', '#.............#', '#.............#', '#..@..........#', '#.............#', '#.............#', '###############'];
const withGhost = (rows, x, y) => rows.map((r, j) => (j === y ? r.slice(0, x) + 'A' + r.slice(x + 1) : r));

function build(config, { confidence = true, ask, decide = clawDecide } = {}) {
  const real = Math.random;
  Math.random = mulberry32(0xc0ffee); // the option shuffle: reproducible
  const run = newTestGame(config, { ask, decide, dir: url, memoryDir: url, confidence });
  Math.random = real;
  return run;
}
// Plays `n` ticks (stopping at a win or loss), calling hook(turn, run, tick) after each; returns the turns.
async function play(run, n, hook = null) {
  const turns = [];
  const real = Math.random;
  Math.random = mulberry32(0xbeef);
  try {
    for (let t = 1; t <= n && !run.game.won && !run.game.lost; t++) {
      const turn = await run.playTurn();
      turns.push(turn);
      await hook?.(turn, run, t);
    }
  } finally { Math.random = real; }
  return turns;
}
const C = (run) => run.memory.progress.confidence;

// 2. strike +6, dispel +12 (a 2 hp ghost: 50 -> 56 -> 68); then a hit on the last life clamps to the cap 45; blocked never lowers C.
{
  const run = build({ map: withGhost(ROOM, 10, 3), seed: 2, explorerSkills: ['sword_strike'], ghostHp: 2 }, { ask: stub({ mood: 'bold', tactic: 'engage', skill: true }) });
  run.game.adversaries.forEach((a) => { a.mode = 'chase'; });
  run.game.health = run.game.maxHealth = 9;
  const trace = [];
  let prevH = 50; // the report's `value` is C = capability + history; these checks follow the history score H
  await play(run, 40, (turn) => trace.push({ v: turn.confidence.history, d: (() => { const d = Math.round((turn.confidence.history - prevH) * 100) / 100; prevH = turn.confidence.history; return d; })(), why: turn.confidence.reason, ev: turn.events.map((e) => e.type) }));
  const struck = trace.find((x) => x.ev.includes('struck'));
  const dispelled = trace.find((x) => x.ev.includes('dispelled'));
  ok(struck && struck.d === 6 && struck.v === 56 && struck.why === 'struck', `strike tick: +6 to 56, got ${JSON.stringify(struck)}`);
  ok(dispelled && dispelled.d === 12 && dispelled.v === 68 && dispelled.why === 'dispelled', `dispel tick: +12 to 68, got ${JSON.stringify(dispelled)}`);
  ok(trace.every((x) => x.ev.includes('struck') || x.ev.includes('dispelled') || x.d === 0), 'no other tick moved C (no pressed under the engage hold or with the sword ready)');
  ok(C(run).counts.strikes === 2 && C(run).value === 68, `after the duel: ${JSON.stringify(C(run))}`);
  await run.explorer.noteBlocked();
  ok(C(run).value === 68 && C(run).counts.blocked === 1, 'blocked above 65 leaves C alone (counted)');
  run.game.health = 1; run.game.maxHealth = 2; // the hit just took the first of 2 lives
  await run.explorer.noteHit('a1');
  ok(C(run).value === 45, `hit from 68 on the last life of 2: min(53, cap 45) = 45, got ${C(run).value}`);
}

// 3. hit from 50 -15 (lives cap table), blocked +3 up to the 65 ceiling, the cap after a gain.
for (const [maxLives, lives, want] of [[2, 1, 35], [3, 2, 35], [3, 1, 35], [9, 8, 35]]) {
  const run = build({ map: ROOM, seed: 3, numAdversaries: 0 }, { ask: stub() });
  run.game.maxHealth = maxLives; run.game.health = lives;
  await run.explorer.noteHit('a1');
  ok(C(run).value === want, `hit from 50 (lives ${lives}/${maxLives}): ${want}, got ${C(run).value}`);
}
{
  const run = build({ map: ROOM, seed: 3, numAdversaries: 0 }, { ask: stub() });
  const seq = [];
  for (let i = 0; i < 7; i++) { await run.explorer.noteBlocked(); seq.push(C(run).value); }
  ok(seq.join() === '53,56,59,62,65,65,65', `blocked +3 up to 65: ${seq}`);
  const last = build({ map: ROOM, seed: 3, numAdversaries: 0 }, { ask: stub() });
  last.game.maxHealth = 2; last.game.health = 1;
  await last.explorer.noteBlocked();
  ok(C(last).value === 45, `blocked on the last life of 2 is clamped to the cap 45, got ${C(last).value}`);
  const one = build({ map: ROOM, seed: 3, numAdversaries: 0 }, { ask: stub() });
  one.game.maxHealth = 1; one.game.health = 1;
  await one.explorer.noteBlocked();
  ok(C(one).value === 53, `maxLives 1: the cap is 100, got ${C(one).value}`);
}

// 4. regen: nothing happens for REGEN_WAIT quiet ticks after a change, then +0.25 per tick toward 50, enemy in sight or not.
{
  const run = build({ map: ROOM, seed: 4, numAdversaries: 0 }, { ask: stub() });
  run.game.maxHealth = 3; run.game.health = 2;
  await run.explorer.noteHit('a1');
  const turns = await play(run, 20);
  ok(Math.abs(C(run).value - 37.5) < 1e-9, `35, ten quiet ticks of waiting, then 10 regen steps of 0.25 = 37.5, got ${C(run).value}`);
  ok(turns[0].confidence.reason === 'hit' && turns[1].confidence.reason === null, `the first report names the hit, quiet ticks name nothing: ${JSON.stringify(turns.slice(0, 2).map((t) => t.confidence.reason))}`);
  const quiet = build({ map: ROOM, seed: 4, numAdversaries: 0 }, { ask: stub() });
  await play(quiet, 30);
  ok(C(quiet).value === 50, 'at 50 regen adds nothing');
}

// 4b. coins never move confidence: picking piles up (even a dropped one) changes neither H nor its counts
{
  const rows = ROOM.map((r, y) => (y === 3 ? r.slice(0, 4) + 'cc' + r.slice(6) : r));
  const run = build({ map: rows, seed: 4, numAdversaries: 0 }, { ask: stub() });
  const before = JSON.stringify(C(run));
  run.game.applyMove('right'); // 4,3 -> coin
  run.game.applyMove('right'); // 5,3 -> coin
  ok(run.game.coins === 2, `the explorer picked up its coins (${run.game.coins})`);
  const turns = await play(run, 12);
  ok(turns.some((t) => t.confidence) && C(run).value === 50 && JSON.stringify(C(run).counts) === JSON.stringify(JSON.parse(before).counts), `coins leave confidence alone: ${JSON.stringify(C(run))}`);
  ok(turns.every((t) => !/coin/.test(String(t.confidence.reason ?? ''))), 'no confidence report names a coin');
}

// 5. evaded: a chasing sighting that ends with no hit and no dispel gives +4; a hit or a dispel in it cancels it.
async function encounter({ hit = false } = {}) {
  const run = build({ map: withGhost(ROOM, 10, 3), seed: 5, ghostSkills: 'none' }, { ask: stub({ mood: 'steady', tactic: 'run_away' }) });
  run.game.adversaries.forEach((a) => { a.mode = 'chase'; });
  let over = null;
  await play(run, 40, async (turn, r, t) => {
    if (t === 2) { // two ticks of chasing sighting, then the ghost is gone (a test hazard: it hides the ghost, nothing else)
      if (hit) { r.game.maxHealth = 3; r.game.health = 2; await r.explorer.noteHit('a1'); }
      r.game.adversaries = [];
    }
    if (turn.decision?.trigger === 'chase_over' && !over) over = { v: turn.confidence.history, why: turn.confidence.reason, evaded: C(r).counts.evaded };
  });
  return { run, over };
}
{
  const { run, over } = await encounter();
  ok(over && over.evaded === 1 && over.v === 54 && /evaded/.test(over.why), `chase_over after a chasing sighting, no hit: evaded +4 to 54, got ${JSON.stringify(over)}`);
  const hurt = await encounter({ hit: true });
  ok(hurt.over && hurt.over.evaded === 0 && !/evaded/.test(hurt.over.why ?? ''), `a hit in the encounter cancels evaded: ${JSON.stringify(hurt.over)}`);
  ok(hurt.over.v < 40, `... and C is still low at chase_over, got ${hurt.over.v}`);
  // Patrolling ghost only (never chasing): no evaded.
  const p = build({ map: withGhost(ROOM, 10, 3), seed: 5, ghostSkills: 'none' }, { ask: stub({ mood: 'steady', tactic: 'carry_on' }) });
  let seenPatrol = false;
  await play(p, 40, (turn, r, t) => {
    if (t === 2) r.game.adversaries = [];
    if (r.game.adversaries.length) { r.game.adversaries.forEach((a) => { if (a.mode === 'chase') a.mode = 'patrol'; }); seenPatrol = true; }
  });
  ok(seenPatrol && C(p).counts.evaded === 0, `a patrolling-only encounter is not evaded (evaded ${C(p).counts.evaded})`);
  // A dispel in the encounter cancels it: two 1 hp ghosts, the near one is dispelled, the far one then removed.
  const k = build({ map: withGhost(withGhost(ROOM, 6, 3), 13, 1), seed: 6, explorerSkills: ['sword_strike'], ghostHp: 1 }, { ask: stub({ mood: 'bold', tactic: 'engage', skill: true }) });
  k.game.adversaries.forEach((a) => { a.mode = 'chase'; });
  k.game.health = k.game.maxHealth = 9;
  let dispels = 0, over2 = null;
  await play(k, 60, (turn, r) => {
    if (turn.events.some((e) => e.type === 'dispelled')) { dispels++; if (r.game.adversaries.length) r.game.adversaries = []; }
    if (turn.decision?.trigger === 'chase_over' && !over2) over2 = C(r).counts.evaded;
  });
  ok(dispels >= 1 && over2 === 0 && C(k).counts.evaded === 0, `a dispel in the encounter cancels evaded (dispels ${dispels}, evaded ${C(k).counts.evaded})`);
}

// 6. pressed: a chaser within 2 steps, sword not ready: -2 per tick, at most -8 per encounter (a dead end, no sword, harmless claws).
{
  const run = build({ map: ['##########', '##########', '#@..A....#', '##########', '##########'], seed: 7, explorerSkills: 'none', ghostSkills: 'none' }, { ask: stub({ mood: 'wary', tactic: 'run_away' }) });
  run.game.adversaries.forEach((a) => { a.mode = 'chase'; });
  const turns = await play(run, 30);
  const c = C(run);
  ok(c.counts.pressed >= 5, `a cornered, swordless explorer is pressed on several ticks, got ${c.counts.pressed}`);
  const hs = turns.map((t) => t.confidence.history);
  ok(Math.min(...hs) === 42, `pressed stops at -8 per encounter: 42, got ${Math.min(...hs)}`);
  ok(hs.every((h, i) => { const d = h - (i ? hs[i - 1] : 50); return d >= -2 && d <= 0.25; }), 'each pressed tick is -2 at most (regen waits 10 ticks after it)');
}

// 7. fog twin: a ghost walled into another room (two different cells) changes neither C nor any request.
{
  const rows = ['#################', '#..@..#.........#', '#.....#.........#', '#.....#.........#', '#################'];
  const play2 = async (gx, gy) => {
    const bodies = [];
    const run = build({ map: withGhost(rows, gx, gy), seed: 8 }, { ask: async (req) => { bodies.push(req.body); return stub()(req); } });
    const trace = (await play(run, 25)).map((t) => t.confidence.history);
    return { trace, bodies, memory: JSON.stringify(C(run)) };
  };
  const a = await play2(10, 1), b = await play2(15, 3);
  ok(a.trace.join() === b.trace.join() && a.memory === b.memory, 'twin: a hidden ghost somewhere else leaves C identical');
  ok(a.bodies.length === b.bodies.length && a.bodies.every((x, i) => x === b.bodies[i]), 'twin: requests byte-identical');
}

// 8. blocked through Run.playTurn: every 'blocked' event of the explorer's own shield (shieldChance 1) is
// forwarded once by turn.js (counts.blocked equals the events) and named in the next turn's report.
{
  const before = skillConfig();
  configureSkills({ ...before, shieldChance: 1 });
  try {
    const run = build({ map: ['##########', '##########', '#@..A....#', '##########', '##########'], seed: 9, explorerSkills: ['shield_block'] }, { ask: stub({ mood: 'wary', tactic: 'run_away', skill: true }) });
    run.game.adversaries.forEach((a) => { a.mode = 'chase'; });
    run.game.health = run.game.maxHealth = 9;
    let blocked = 0, hits = 0, bad = 0, owed = false;
    await play(run, 30, (turn, r) => {
      // A block forwarded after a turn shows in the NEXT turn's report.
      if (owed && !/blocked/.test(turn.confidence.reason ?? '')) bad++;
      const b = turn.events.filter((e) => e.type === 'blocked').length;
      hits += turn.events.filter((e) => e.type === 'hit').length;
      blocked += b; owed = b > 0;
      if (C(r).counts.blocked !== blocked) bad++;
    });
    ok(blocked >= 1 && bad === 0, `every blocked event is forwarded once and reported next turn: ${blocked} blocked, ${hits} hits, ${bad} mismatches, counts ${JSON.stringify(C(run).counts)}`);
  } finally { configureSkills(before); }
}

// 9. pressed is not counted for a ghost the explorer's own strike stunned: sword cooldown 6, stun 4, a dead end,
// run_away (not engage). Ticks right after the strike (the ghost stunned within 2 steps, sword down) are not pressed.
{
  const before = skillConfig();
  configureSkills({ ...before, swordCooldown: 6, stunTicks: 4 });
  try {
    const run = build({ map: ['##########', '##########', '#@..A....#', '##########', '##########'], seed: 10, explorerSkills: ['sword_strike'], ghostSkills: 'none', ghostHp: 5 }, { ask: stub({ mood: 'wary', tactic: 'run_away', skill: true }) });
    run.game.adversaries.forEach((a) => { a.mode = 'chase'; });
    let strikeAt = null, pressedInStun = 0, pressedAfter = 0, closeInStun = 0;
    await play(run, 20, (turn, r, t) => {
      if (strikeAt === null && turn.events.some((e) => e.type === 'struck')) { strikeAt = t; return; }
      if (strikeAt === null) return;
      const why = turn.confidence.reason ?? '';
      const near = r.game.adversaries.some((a) => Math.abs(a.pos[0] - r.game.pos[0]) + Math.abs(a.pos[1] - r.game.pos[1]) <= 2);
      if (t - strikeAt < 4) { if (near) closeInStun++; if (/pressed/.test(why)) pressedInStun++; } else if (t - strikeAt < 6 && /pressed/.test(why)) pressedAfter++;
    });
    ok(strikeAt !== null && closeInStun >= 1 && pressedInStun === 0, `no pressed while the own strike's stun lasts (strike tick ${strikeAt}, close ${closeInStun}, pressed ${pressedInStun})`);
    ok(pressedAfter >= 1, `pressed returns once the stun is over and the sword is still down (${pressedAfter})`);
  } finally { configureSkills(before); }
}

rmSync(dir, { recursive: true, force: true });
if (fails) { console.log(`check-confidence-wiring: ${fails} failure(s)`); process.exit(1); }
console.log('check-confidence-wiring: all checks passed');
