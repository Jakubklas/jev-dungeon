// Checks for confidence caps (PLAN-confidence-mood phase 3): the REAL ExplorerBrain with confidence: 'caps' (or an arm object
// { start } that forces the history score H) through the duel harness / newTestGame, stub Jev, throwing fetch tripwire.
//  1. the behaviour matrix: 1/2/3 ghosts x hp 1-3 x lives 2/3/4 x H 20/50/80 x patrolling/chasing: the sentiment options are
//     exactly the moods C allows (id list and count), run_away is on the tactic menu only in the low / midlow tier (or mood),
//     engage is on it when armed;
//     spot values from the plan's tables (W 0.35)
//  2. a scripted Jev at DOMINANT history (H 80) with 2 ghosts in sight is never offered wary, picks bold, engages and dispels
//     both with no death at 2 lives (real health 2), follow and walk-in
//  3. hysteresis (pure rule in check-confidence.mjs 12d)
//  4. the `confidence` trigger fires at most once per encounter per direction
//  5. out of sight a closed mood is swapped to steady silently: a policy, no event, no request
//  6. fog twin: a hidden never-seen ghost leaves C, the options and every request byte-identical
//  7. text: no word 'outnumbered' in any caps-mode request; the claims (stakes, default engage) only under the #fightOn gate;
// Free, no Jev. Run from dungeon-game: node scripts/check-confidence-caps.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clawDecide, mulberry32, openGroups, playDuel } from './lib/duel-harness.mjs'; // installs the fetch tripwire
import { newTestGame } from '../src/turn.js';
import { allowedMoods, capability, combine, retreatTier, tierOf, tierOfMood } from '../src/characters/explorer/confidence.js';
import { SENTIMENTS } from '../src/characters/explorer/brain.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { tacticFeasibility } from '../src/characters/explorer/perception.js';
import { blocksOnlyRoute } from '../src/characters/explorer/encounter.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(`FAIL: ${m}`); } };
const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });
const ORDER = ['wary', 'guarded', 'cautious', 'steady', 'greedy', 'bold', 'fearless'];

// ---- 1. the matrix ----
const SPOTS = [[1, 2, 2, 50, 75], [2, 2, 2, 50, 58], [3, 2, 2, 50, 50], [1, 2, 4, 50, 75], [3, 2, 4, 50, 58]]; // ghosts, hp 2, lives, H -> C (plan 2.2 with W 0.35)
const cells = { 1: [[9, 3]], 2: [[9, 3], [9, 2]], 3: [[9, 3], [9, 2], [9, 4]] };
let combos = 0, checkedMenu = 0;
const retreats = { on: 0, off: 0 };
for (const n of [1, 2, 3]) for (const hp of [1, 2, 3]) for (const L of [2, 3, 4]) for (const H of [20, 50, 80]) for (const mode of ['chase', 'patrol']) {
  const reqs = [];
  let first = null;
  await playDuel({
    ghosts: cells[n], ghostMode: mode, ghostHp: hp, health: L, maxTicks: 1, confidence: { caps: true, start: H },
    onAsk: (r) => reqs.push(r), onTurn: (t) => { first = t; },
  });
  // (the harness sets health = maxHealth = L after the brain is built: the first request sees C at those lives)
  const ghosts = Array.from({ length: n }, () => ({ hp, weight: 1 }));
  const R = capability({ lives: L, maxLives: L, steady: true, armed: true, ghosts });
  const C = combine(R, H, L, L);
  const want = allowedMoods(C, { lastLife: false, swordDown: false, noSword: false, current: 'steady' });
  const sent = reqs.find((r) => r.kind === 'sentiment');
  const tag = `${n} ghosts hp ${hp} lives ${L} H ${H} ${mode}`;
  combos++;
  if (C < 20 && L <= 1) { ok(!sent, `${tag}: C ${C} is panic, entered by code with no sentiment request`); continue; }
  if (!sent) { ok(false, `${tag}: no sentiment request`); continue; }
  const ids = Object.keys(sent.questions.sentiment.criteria).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  ok(JSON.stringify(ids) === JSON.stringify(want), `${tag}: moods ${ids} want ${want} (C ${C})`);
  ok(ids.length === want.length, `${tag}: option count ${ids.length}`);
  ok(String(sent.state.self.confidence).startsWith(`${Math.floor(C)} `), `${tag}: self.confidence ${sent.state.self.confidence}, C ${C}`);
  const menu = first?.decision?.tactic?.options;
  if (menu) {
    checkedMenu++;
    // mid-ground fix: pulling back is on the menu only in the low and midlow tiers (or a low / midlow mood); in mid and high it is
    // left off while a forward tactic is open
    const mood = first.decision.sentiment.choice;
    const retreat = retreatTier(tierOfMood(mood)) || retreatTier(tierOf(C, tierOfMood(mood)));
    ok(('run_away' in menu) === retreat, `${tag}: run_away ${'run_away' in menu ? 'on' : 'off'} the tactic menu at C ${C} (${mood}) ${Object.keys(menu)}`);
    ok(retreat || !('hide' in menu) && !('race_to_exit' in menu), `${tag}: no hide or race_to_exit in mid / high ${Object.keys(menu)}`);
    ok('engage' in menu, `${tag}: engage missing from the tactic menu ${Object.keys(menu)}`);
    retreats[retreat ? 'on' : 'off']++;
  }
}
for (const [n, hp, L, H, want] of SPOTS) {
  const C = combine(capability({ lives: L, maxLives: L, steady: true, armed: true, ghosts: Array.from({ length: n }, () => ({ hp, weight: 1 })) }), H, L, L);
  ok(C === want, `spot ${n} ghosts hp ${hp} lives ${L}: C ${C} want ${want}`);
}
ok(combos === 3 * 3 * 3 * 3 * 2 && checkedMenu > 60, `matrix ran ${combos} combos, ${checkedMenu} tactic menus`);
ok(retreats.on > 5 && retreats.off > 5, `the matrix sees menus with and without the retreats: ${JSON.stringify(retreats)}`);
// More enemies in sight than the engage hold covers (4): the retreats come back even at a high C.
{
  let menu = null;
  await playDuel({ ghosts: [[9, 3], [9, 2], [9, 4], [10, 3]], ghostMode: 'chase', ghostHp: 2, health: 4, maxTicks: 1, confidence: { caps: true, start: 80 }, onTurn: (t) => { menu = t.decision?.tactic?.options; } });
  ok(menu && 'run_away' in menu, `4 enemies in sight at a high C: run_away on the menu (${Object.keys(menu ?? {})})`);
}

// ---- 2. DOMINANT history with 2 ghosts in sight ----
{
  let runs = 0, bold = 0, engaged = 0, lost = 0, notCleared = 0, wary = 0, hits = 0;
  for (const policy of ['follow', 'walk-in']) for (const n of [0, 2, 4]) for (const group of openGroups(2, n).filter((_, i) => i % 3 === 0)) {
    const moods = []; let engagedHere = false, boldHere = false;
    const r = await playDuel({
      ghosts: group, ghostHp: 2, health: 2, maxTicks: 90, policy, confidence: { caps: true, start: 80 }, mood: 'bold',
      onAsk: (q) => { if (q.kind === "sentiment" && q.state.self.lives > 1) moods.push(Object.keys(q.questions.sentiment.criteria)); },
      onTurn: (t) => { if (t.decision?.tactic?.choice === 'engage') engagedHere = true; if (t.decision?.sentiment?.choice === 'bold') boldHere = true; },
    });
    runs++; if (engagedHere) engaged++; if (boldHere) bold++;
    if (moods.some((m) => m.includes('wary'))) wary++;
    if (r.lost) lost++;
    if (r.dispelled < 2) notCleared++;
    hits += r.hitsTaken;
  }
  ok(wary === 0, `DOMINANT with 2 ghosts: wary was offered with more than one life left in ${wary} of ${runs} runs`);
  ok(bold === runs, `bold picked in ${bold} of ${runs} runs`);
  ok(engaged === runs, `engage chosen in ${engaged} of ${runs} runs`);
  ok(lost === 0 && notCleared === 0, `no death and both dispelled at 2 lives (lost ${lost}, not cleared ${notCleared}, hits ${hits}, ${runs} runs)`);
  console.log(`  DOMINANT 2-ghost runs: ${runs}, wary offered ${wary}, engaged ${engaged}, lost ${lost}, hits ${hits}`);
}

// ---- helpers for a hand-driven Run (3-6) ----
const dir = mkdtempSync(join(tmpdir(), 'jev-caps-'));
const url = pathToFileURL(dir + '/');
const OPEN = ['###############', '#.............#', '#.............#', '#..@..........#', '#.............#', '#.............#', '###############'];
const put = (rows, cs) => rows.map((r, y) => r.split('').map((ch, x) => (cs.some((c) => c[0] === x && c[1] === y) ? 'A' : ch)).join(''));
// pick(keys) is the scripted mood; tactic engage when offered else the first; the move is stay (nothing walks into a ghost).
function make({ rows = OPEN, ghosts = [[9, 3], [9, 2], [9, 4]], H = 50, ghostSkills = 'none', maxLives = 4, lives = 4, pick = (k) => (k.includes('bold') ? 'bold' : k.includes('steady') ? 'steady' : k[0]), log = [] } = {}) {
  const real = Math.random;
  Math.random = mulberry32(0xc0ffee);
  const ask = async (req) => {
    log.push(req);
    const out = {};
    for (const [k, q] of Object.entries(req.questions)) {
      if (q.type === 'noul') { out[k] = { noul: k === 'leave_now' ? 0.1 : 0.9 }; continue; }
      const keys = Object.keys(q.criteria);
      if (k === 'sentiment') out[k] = answer(pick(keys));
      else if (k === 'tactic') out[k] = answer(keys.includes('engage') ? 'engage' : keys[0]);
      else if (k === 'skill') out[k] = answer('none');
      else if (k === 'next_move' || k.startsWith('move_if_')) out[k] = answer(keys.includes('stay') ? 'stay' : keys[0]);
      else out[k] = answer(keys[0]);
    }
    return out;
  };
  const run = newTestGame({ map: put(rows, ghosts), seed: 1, ghostSkills }, { ask, decide: clawDecide, dir: url, memoryDir: url, confidence: { caps: true, start: H } });
  Math.random = real;
  run.game.maxHealth = maxLives;
  run.game.health = lives;
  return run;
}
async function tick(run) {
  const real = Math.random;
  Math.random = mulberry32(0xbeef + run.game.steps);
  try { return await run.playTurn(); } finally { Math.random = real; }
}
const sentimentKeys = (log) => log.filter((r) => r.kind === 'sentiment').map((r) => Object.keys(r.questions.sentiment.criteria).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));

// ---- 3. hysteresis: the tier edges keep the current mood's tier 5 points past the edge; that is a pure rule, checked for every C in
// check-confidence.mjs section 12(d) (allowedMoods), and exercised end to end by the tier swaps in sections 4 and 5 below.

// ---- 4. the confidence trigger: once per encounter per direction ----
{
  const log = [];
  const r = make({ H: 70, log });
  r.game.adversaries.forEach((a) => { a.mode = "chase"; }); // no patrol->chase encounter trigger in the way
  await tick(r); // 4 lives, 3 enemies, H 70: C 76, high tier, bold
  r.memory.sentiment.id = 'fearless'; // a high-tier-only mood (bold is also offered in the mid tier)
  r.game.health = 3; // C 59: the high tier closed
  const triggers = [];
  for (let i = 0; i < 12 && !r.game.lost; i++) { const t = await tick(r); if (t.decision) triggers.push(t.decision.trigger); }
  const n = triggers.filter((x) => x === 'confidence').length;
  ok(n === 1, `confidence trigger fires exactly once per encounter (got ${n}: ${triggers})`);
  const after = sentimentKeys(log).at(-1);
  ok(after && after.includes('bold') && !after.includes('fearless'), `after the high tier closed the question lists ${after} (bold stays, it is mid too)`);
  ok(log.some((q) => q.kind === 'sentiment' && /Your confidence changed enough/.test(q.questions.sentiment.instructions)), 'the confidence trigger text is in the sentiment question');
}

// ---- 5. out of sight: a silent swap to steady ----
{
  const log = [];
  const r = make({ H: 40, lives: 3, maxLives: 4, ghosts: [[9, 3], [9, 2], [9, 4]], log, pick: (k) => (k.includes('wary') ? 'wary' : k[0]) });
  await tick(r);
  ok(r.memory.sentiment.id === 'wary', `swap setup: wary picked at low C (got ${r.memory.sentiment.id})`);
  r.game.maxHealth = r.game.health = 4; // C jumps past the wary band
  r.game.adversaries = []; // out of sight
  const events = r.memory.events.length;
  const reqs = log.length;
  let policy = null;
  for (let i = 0; i < 3 && !policy; i++) { const t = await tick(r); policy = t.policy ?? null; }
  ok(policy && policy.from === 'wary' && policy.to === 'steady' && /^confidence \d+$/.test(policy.reason), `silent swap records a policy (got ${JSON.stringify(policy)})`);
  ok(r.memory.sentiment.id === 'steady', 'the swap sets steady');
  ok(!r.memory.events.slice(events).some((e) => /confidence|wary|steady/i.test(e.text)), 'the swap adds no memory event');
  ok(log.slice(reqs).every((q) => q.kind !== 'sentiment'), 'the swap makes no sentiment call');
}

// ---- 6. fog twin: a hidden unseen ghost changes nothing ----
{
  const walled = ['###############', '#.............#', '#.............#', '#..@..........#', '#.............#', '#.............#', '###############', '#.....#########', '###############'];
  const play = async (hidden) => {
    const log = [];
    const r = make({ rows: walled, ghosts: [[9, 3], ...hidden], H: 50, log });
    for (let i = 0; i < 6; i++) await tick(r);
    return log.map((q) => q.body);
  };
  const a = await play([]);
  const b = await play([[2, 7]]);
  const c = await play([[2, 7], [5, 7]]);
  ok(a.length > 0 && JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) === JSON.stringify(c), 'fog twin: hidden unseen ghosts leave every request byte-identical');
}

// ---- 7. text ----
{
  const bodies = [];
  const first = async (o) => { const sent = []; await playDuel({ maxTicks: 1, onAsk: (r) => { bodies.push(r.body); sent.push(r); }, ...o }); return sent; };
  const stakes = /each dispel removes an enemy for good/;
  const dflt = /Default: engage while the sword is ready \(you act first; hold off the nearest\)/;
  const text = (sent) => sent.map((r) => JSON.stringify(r.questions)).join('\n');
  for (const [name, o, wantClaim] of [
    ['2 ghosts', { ghosts: cells[2] }, true],
    ['3 ghosts', { ghosts: cells[3] }, true],
    ['3 ghosts at speed 1 (no numeric gate)', { ghosts: cells[3], settings: { speed: 1 } }, true],
    ['4 ghosts (no numeric gate)', { ghosts: [[9, 3], [9, 2], [9, 4], [10, 3]] }, true],
    ['2 ghosts hp 4 (no numeric gate)', { ghosts: cells[2], ghostHp: 4 }, true],
    ['2 ghosts, claw damage 2 at 2 lives (one claw is the last life: low tier)', { ghosts: cells[2], health: 2, settings: { clawDamage: 2 } }, false],
    ['2 ghosts, stun 1 (no numeric gate)', { ghosts: cells[2], settings: { stunTicks: 1 } }, true],
    ['2 ghosts, sword cooldown 2 (no numeric gate)', { ghosts: cells[2], settings: { swordCooldown: 2 } }, true],
    ['2 ghosts at C below 40', { ghosts: cells[2], confidence: { caps: true, start: 20 }, health: 2 }, false],
  ]) {
    const t = text(await first({ confidence: { caps: true, start: 80 }, ghostHp: 2, health: 4, ...o }));
    ok(stakes.test(t) === wantClaim, `claim gate (${name}): stakes sentence ${stakes.test(t) ? 'present' : 'absent'}, want ${wantClaim ? 'present' : 'absent'}`);
    ok(!/\d\+? (adversar|enem|monster|ghost)/i.test(t), `no counts on enemies (${name})`);
  }
  // steady: the default engage line is for a single or hurt monster, not for two full-health ones
  {
    const sent = await first({ ghosts: cells[2], ghostHp: 2, health: 4, confidence: { caps: true, start: 50 }, mood: 'steady' });
    ok(!sent.some((r) => dflt.test(JSON.stringify(r.questions))), 'steady, two healthy enemies: no default engage line');
  }
  // one ghost: today's lone-fight wording
  {
    // start 30: C 55, mid tier, where steady is offered. Mid leaves the retreats off the menu, so with engage the only forward
    // tactic here code takes it (no tactic question); when a question is asked, it carries the lone-fight default line.
    const sent = []; let turn = null;
    await playDuel({ ghosts: cells[1], ghostHp: 2, health: 2, maxTicks: 1, confidence: { caps: true, start: 30 }, mood: 'steady', onAsk: (r) => { bodies.push(r.body); sent.push(r); }, onTurn: (x) => { turn = x; } });
    const t = text(sent);
    const byCode = !sent.some((r) => r.questions.tactic) && turn?.decision?.tactic?.choice === 'engage';
    ok((/Default: engage a lone enemy/.test(t) || byCode) && /A single enemy you strike first costs little/.test(t), 'one enemy: the single-monster wording (or engage taken by code)');
  }
  for (const g of [cells[3], [[9, 3], [9, 2], [9, 4], [10, 3]]]) {
    await playDuel({ ghosts: g, ghostHp: 2, health: 4, maxTicks: 25, confidence: { caps: true, start: 50 }, onAsk: (r) => bodies.push(r.body) });
  }
  ok(bodies.length > 20 && !bodies.some((b) => /\d\+? (adversar|enem|monster|ghost)/i.test(b)), `no counts on enemies in ${bodies.length} requests`);
  ok(ORDER.every((id) => id in SENTIMENTS), 'the four moods are still in SENTIMENTS (commit 3 replaces them)');
}

// ---- 8. panic (PLAN-moods): entered by code below C 20 at 1 life or less, no sentiment call, run_away only, a whisper cannot override it, ends at C 25 ----
{
  const log = [];
  const run = make({ H: 0, maxLives: 4, lives: 1, ghosts: [[9, 3], [9, 2], [9, 4]], log });
  run.game.adversaries.forEach((a) => { a.mode = 'chase'; });
  const t0 = await tick(run);
  ok(run.memory.sentiment.id === 'panic', `three chasing enemies at 1 life and a beaten history: panic (got ${run.memory.sentiment.id})`);
  ok(!log.some((r) => r.kind === 'sentiment'), 'panic is entered without a sentiment call');
  const menus = log.map((r) => Object.keys(r.questions.tactic?.criteria ?? {})).filter((m) => m.length);
  ok(menus.every((m) => m.every((id) => ['run_away', 'race_to_exit', 'engage'].includes(id))), `panic offers only run_away / race_to_exit / engage: ${JSON.stringify(menus)}`);
  ok(menus.every((m) => m.includes('run_away')) && t0.decision?.tactic?.choice === 'run_away', `run_away is on the panic menu and taken: ${JSON.stringify(menus)} ${t0.decision?.tactic?.choice}`);
  ok(!/\blives?\b/i.test(SENTIMENTS.panic.priority + SENTIMENTS.panic.move_priority + SENTIMENTS.panic.skill_priority + SENTIMENTS.panic.note), 'panic text never mentions lives');
  // a whisper does not apply while panicking
  await run.explorer.setDirective('walk to the east wall', { steps: 20 });
  const n0 = log.length;
  await tick(run);
  ok(log.slice(n0).every((r) => !r.state.directive), 'a directive is not sent to Jev while panicking');
  ok(run.memory.sentiment.id === 'panic', 'still panic');
  // the threat gone: C climbs back (the remembered sightings fade), panic ends only at 25 or more, by code
  run.game.adversaries = [];
  run.game.health = run.game.maxHealth; // and the hurt explorer healed (a heart): R recovers, H stays beaten
  let left = null;
  for (let i = 0; i < 80 && !left; i++) { await tick(run); if (run.memory.sentiment.id !== 'panic') left = i; }
  ok(left !== null, 'panic ends once C is back at 25');
  ok(run.memory.sentiment.id !== 'panic' && ['wary', 'guarded', 'cautious', 'steady', 'greedy'].includes(run.memory.sentiment.id), `panic hands over to a calm mood (${run.memory.sentiment.id})`);
}
{
  // engage is on the panic menu only when the enemies shut the only way out
  const open = make({ rows: OPEN, ghosts: [[9, 3]], lives: 2, maxLives: 2 });
  const w1 = new KnownWorld(open.game);
  open.game.adversaries.forEach((a) => { a.mode = 'chase'; });
  ok(!blocksOnlyRoute(w1, [{ pos: [9, 3] }]) , 'an open room is never blocked');
  ok(!('engage' in tacticFeasibility(w1, 1, { armed: true, panic: true })), 'open room: no engage in panic');
  const hall = make({ rows: ['#'.repeat(24), '#'.repeat(24), '#@' + '.'.repeat(21) + '#', '#'.repeat(24), '#'.repeat(24)], ghosts: [[4, 2]], lives: 2, maxLives: 2 });
  hall.game.adversaries.forEach((a) => { a.mode = 'chase'; });
  const w2 = new KnownWorld(hall.game);
  ok(blocksOnlyRoute(w2, [{ pos: [4, 2] }]), 'a long hall with the enemy between the explorer and the unexplored end is blocked');
  ok('engage' in tacticFeasibility(w2, 1, { armed: true, panic: true }), 'blocked: engage is on the panic menu');
  ok(!('engage' in tacticFeasibility(w2, 1, { armed: false, panic: true })), 'no sword: no engage even when blocked');
  ok(Object.keys(tacticFeasibility(w2, 1, { armed: true, panic: true })).every((id) => ['run_away', 'race_to_exit', 'engage'].includes(id)), 'panic menu holds no subtle tactics');
}

rmSync(dir, { recursive: true, force: true });
if (fails) { console.log(`check-confidence-caps: ${fails} failure(s)`); process.exit(1); }
console.log('check-confidence-caps: ok');
