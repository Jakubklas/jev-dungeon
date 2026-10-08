// Checks for the confidence model's wiring in the brain (PLAN-confidence C2): the REAL ExplorerBrain through
// newTestGame with the `confidence` option, stub Jev, throwing fetch tripwire (the duel harness installs it).
// Event table: each event moves C by the documented delta (strike +5, dispel +8, hit -7 then the lives cap,
// blocked +3 up to 65, evaded +2 up to 65 only for an encounter with a chasing sighting and no hit and no
// dispel, coin +2 each and heart +5 from the explorer's own steps, no pressed penalty, blocked events forwarded by Run), memory shape with the toggle on and
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

// 2. strike +5, dispel +8 (a 2 hp ghost: 50 -> 55 -> 63); then a hit on the last life clamps to the cap 45; blocked never lowers C.
{
  const run = build({ map: withGhost(ROOM, 10, 3), seed: 2, explorerSkills: ['sword_strike'], ghostHp: 2 }, { ask: stub({ mood: 'bold', tactic: 'engage', skill: true }) });
  run.game.adversaries.forEach((a) => { a.mode = 'chase'; });
  run.game.health = run.game.maxHealth = 9;
  const trace = [];
  let prevH = 50; // the report's `value` is C = capability + history; these checks follow the history score H
  await play(run, 40, (turn) => trace.push({ v: turn.confidence.history, d: (() => { const d = Math.round((turn.confidence.history - prevH) * 100) / 100; prevH = turn.confidence.history; return d; })(), why: turn.confidence.reason, ev: turn.events.map((e) => e.type) }));
  const struck = trace.find((x) => x.ev.includes('struck'));
  const dispelled = trace.find((x) => x.ev.includes('dispelled'));
  ok(struck && struck.d === 5 && struck.v === 55 && struck.why === 'struck', `strike tick: +5 to 55, got ${JSON.stringify(struck)}`);
  ok(dispelled && dispelled.d === 8 && dispelled.v === 63 && dispelled.why === 'dispelled', `dispel tick: +8 to 63, got ${JSON.stringify(dispelled)}`);
  ok(trace.every((x) => x.ev.includes('struck') || x.ev.includes('dispelled') || x.d === 0), 'no other tick moved C (no pressed under the engage hold or with the sword ready)');
  ok(C(run).counts.strikes === 2 && C(run).value === 63, `after the duel: ${JSON.stringify(C(run))}`);
  await run.explorer.noteBlocked();
  ok(C(run).value === 65 && C(run).counts.blocked === 1, 'blocked from 63 rises to the 65 ceiling and counts');
  await run.explorer.noteBlocked();
  ok(C(run).value === 65 && C(run).counts.blocked === 2, 'blocked at the ceiling leaves C alone (counted)');
  run.game.health = 1; run.game.maxHealth = 2; // the hit just took the first of 2 lives
  await run.explorer.noteHit('a1');
  ok(C(run).value === 45, `hit from 65 on the last life of 2: min(58, cap 45) = 45, got ${C(run).value}`);
}

// 3. hit from 50 -7 (lives cap table), blocked +3 up to the 65 ceiling, the cap after a gain.
for (const [maxLives, lives, want] of [[2, 1, 43], [3, 2, 43], [3, 1, 43], [9, 8, 43]]) {
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
  ok(Math.abs(C(run).value - 45.5) < 1e-9, `43, ten quiet ticks of waiting, then 10 regen steps of 0.25 = 45.5, got ${C(run).value}`);
  ok(turns[0].confidence.reason === 'hit' && turns[1].confidence.reason === null, `the first report names the hit, quiet ticks name nothing: ${JSON.stringify(turns.slice(0, 2).map((t) => t.confidence.reason))}`);
  const quiet = build({ map: ROOM, seed: 4, numAdversaries: 0 }, { ask: stub() });
  await play(quiet, 30);
  ok(C(quiet).value === 50, 'at 50 regen adds nothing');
}

// 4b. coins +2 each and a heart +5, from the explorer's own steps (applyMove's coins / healed): the report names them. The heart is
// applied after the heal, so the lives cap sees the restored life.
{
  const walk = async (rows, extra = {}) => build({ map: rows, seed: 4, numAdversaries: 0, ...extra }, { ask: async (req) => { const out = await stub()(req); if (out.next_move) out.next_move = answer(Object.keys(req.questions.next_move.criteria).includes('right') ? 'right' : out.next_move.choice); return out; } });
  const rows = ROOM.map((r, y) => (y === 3 ? r.slice(0, 4) + 'cc' + r.slice(6) : r));
  const run = await walk(rows);
  const t1 = await run.playTurn(); // onto the first coin
  ok(C(run).counts.coins === 1 && Math.abs(C(run).value - 52) < 1e-9 && /coin/.test(t1.confidence.reason ?? ''), `first coin: +2, named: ${JSON.stringify(C(run))} ${t1.confidence.reason}`);
  await run.playTurn();
  ok(C(run).counts.coins === 2 && Math.abs(C(run).value - 54) < 1e-9, `second coin: +2 more: ${JSON.stringify(C(run))}`);
  const hearts = ROOM.map((r) => r);
  const h = await walk(hearts, { hearts: [[4, 3]] });
  h.game.health = h.game.maxHealth - 1;
  const th = await h.playTurn();
  ok(h.game.health === h.game.maxHealth && C(h).counts.hearts === 1 && Math.abs(C(h).value - 55) < 1e-9 && /heart/.test(th.confidence.reason ?? ''), `heart: healed, +5, named: health ${h.game.health}/${h.game.maxHealth} ${JSON.stringify(C(h))} ${th.confidence.reason}`);
  const full = await walk(hearts, { hearts: [[4, 3]] });
  await full.playTurn();
  ok(C(full).counts.hearts === 0 && C(full).value === 50, 'a heart left on the floor at full lives gives nothing');
}

// 4c. seeing a lone monster costs nothing, even with stunTicks 0 (the main arena's setting) and 4 lives; 2 and 3 monsters at full lives keep C >= 50;
// being chased for 10 ticks unhurt never lowers H; a hit still lowers C.
{
  const before = skillConfig();
  configureSkills({ ...before, stunTicks: 0 });
  try {
    const LONG = ['#####################', '#...................#', '#...................#', '#..@................#', '#...................#', '#...................#', '#####################'];
    const cells = [[12, 3], [12, 1], [12, 5]];
    for (const n of [1, 2, 3]) {
      let rows = LONG; for (let i = 0; i < n; i++) rows = withGhost(rows, cells[i][0], cells[i][1]);
      const run = build({ map: rows, seed: 11, ghostSkills: 'none' }, { ask: stub({ mood: 'bold', tactic: 'carry_on' }) });
      run.game.health = run.game.maxHealth = 4;
      const c0 = run.explorer.constructor && (await run.playTurn()).confidence;
      let lowestC = c0.value, lowestH = c0.history, sawEnemy = false;
      await play(run, 10, (turn, r) => { lowestC = Math.min(lowestC, turn.confidence.value); lowestH = Math.min(lowestH, turn.confidence.history); if (r.game.adversaries.some((a) => a.mode === 'chase')) sawEnemy = true; });
      ok(lowestH === 50, `${n} monster(s), stunTicks 0, 4 lives, unhurt: H never drops (lowest ${lowestH})`);
      ok(lowestC >= 50, `${n} monster(s), stunTicks 0, 4 lives, unhurt: C stays >= 50 (lowest ${lowestC})`);
      if (n === 1) ok(lowestC >= 74, `one monster costs nothing: C stays at its unhurt value (lowest ${lowestC})`);
    }
    const hit = build({ map: withGhost(ROOM, 6, 3), seed: 12 }, { ask: stub({ mood: 'bold', tactic: 'carry_on' }) });
    hit.game.health = hit.game.maxHealth = 4;
    const t0 = (await hit.playTurn()).confidence.value;
    hit.game.adversaries.forEach((a) => { a.mode = 'chase'; });
    let hitSeen = false, after = null;
    let owed = false;
    await play(hit, 30, (turn) => { if (owed && after === null) after = turn.confidence.value; if (!hitSeen && turn.events.some((e) => e.type === 'hit')) { hitSeen = true; owed = true; } }); // the hit shows in the next report
    ok(hitSeen && after !== null && after < t0, `a hit still lowers C (${t0} -> ${after})`);
  } finally { configureSkills(before); }
}

// 5. evaded: a chasing sighting that ends with no hit and no dispel gives +2; a hit or a dispel in it cancels it.
async function encounter({ hit = false } = {}) {
  const run = build({ map: withGhost(ROOM, 10, 3), seed: 5, ghostSkills: 'none' }, { ask: stub({ mood: 'bold', tactic: 'run_away' }) });
  run.game.adversaries.forEach((a) => { a.mode = 'chase'; });
  let over = null;
  await play(run, 40, async (turn, r, t) => {
    if (t === 1) { // one tick of chasing sighting (bold's end_ticks is 1), then the ghost is gone (a test hazard: it hides the ghost, nothing else)
      if (hit) { r.game.maxHealth = 3; r.game.health = 2; await r.explorer.noteHit('a1'); }
      r.game.adversaries = [];
    }
    if (turn.decision?.trigger === 'chase_over' && !over) over = { v: turn.confidence.history, why: turn.confidence.reason, evaded: C(r).counts.evaded };
  });
  return { run, over };
}
{
  const { run, over } = await encounter();
  ok(over && over.evaded === 1 && over.v === 52 && /evaded/.test(over.why), `chase_over after a chasing sighting, no hit: evaded +2 (a lone enemy with the sword ready does not press) to 52, got ${JSON.stringify(over)}`);
  const hurt = await encounter({ hit: true });
  ok(hurt.over && hurt.over.evaded === 0 && !/evaded/.test(hurt.over.why ?? ''), `a hit in the encounter cancels evaded: ${JSON.stringify(hurt.over)}`);
  ok(hurt.over.v < 44, `... and C is still low at chase_over, got ${hurt.over.v}`);
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

// 6. being chased is no justification: a cornered, swordless explorer chased for 30 ticks (harmless claws) never loses H.
{
  const run = build({ map: ['##########', '##########', '#@..A....#', '##########', '##########'], seed: 7, explorerSkills: 'none', ghostSkills: 'none' }, { ask: stub({ mood: 'wary', tactic: 'run_away' }) });
  run.game.adversaries.forEach((a) => { a.mode = 'chase'; });
  const turns = await play(run, 30);
  ok(Math.min(...turns.map((t) => t.confidence.history)) === 50, 'chased and cornered for 30 ticks: H stays 50');
  ok(turns.every((t) => !/pressed/.test(t.confidence.reason ?? '')) && !('pressed' in C(run).counts), 'no pressed event or count any more');
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

rmSync(dir, { recursive: true, force: true });
if (fails) { console.log(`check-confidence-wiring: ${fails} failure(s)`); process.exit(1); }
console.log('check-confidence-wiring: all checks passed');
