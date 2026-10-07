// Checks for confidence caps (PLAN-confidence-mood phase 3): the REAL ExplorerBrain with confidence: 'caps' (or an arm object
// { start } that forces the history score H) through the duel harness / newTestGame, stub Jev, throwing fetch tripwire.
//  1. the behaviour matrix: 1/2/3 ghosts x hp 1-3 x lives 2/3/4 x H 20/50/80 x patrolling/chasing: the sentiment options are
//     exactly the moods C allows (id list and count), run_away is always on the tactic menu, engage is on it when armed;
//     spot values from the plan's tables (W 0.35)
//  2. a scripted Jev at DOMINANT history (H 80) with 2 ghosts in sight is never offered wary, picks bold, engages and dispels
//     both with no death at 2 lives (real health 2), follow and walk-in
//  3. hysteresis: the same C offers bold to a brain whose mood is bold and not to one whose mood is steady
//  4. the `confidence` trigger fires at most once per encounter per direction
//  5. out of sight a closed mood is swapped to steady silently: a policy, no event, no request
//  6. fog twin: a hidden never-seen ghost leaves C, the options and every request byte-identical
//  7. text: no word 'outnumbered' in any caps-mode request; the claims (stakes, default engage) only under the #fightOn gate;
//     with caps off none of the caps wording appears
// Free, no Jev. Run from dungeon-game: node scripts/check-confidence-caps.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clawDecide, mulberry32, openGroups, playDuel } from './lib/duel-harness.mjs'; // installs the fetch tripwire
import { newTestGame } from '../src/turn.js';
import { allowedMoods, capability, combine } from '../src/characters/explorer/confidence.js';
import { SENTIMENTS } from '../src/characters/explorer/brain.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(`FAIL: ${m}`); } };
const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });
const ORDER = ['wary', 'steady', 'greedy', 'bold'];

// ---- 1. the matrix ----
const SPOTS = [[1, 2, 2, 50, 67], [2, 2, 2, 50, 55], [3, 2, 2, 50, 43], [1, 2, 4, 50, 80], [3, 2, 4, 50, 66]]; // ghosts, hp 2, lives, H -> C (plan 2.2 with W 0.35)
const cells = { 1: [[9, 3]], 2: [[9, 3], [9, 2]], 3: [[9, 3], [9, 2], [9, 4]] };
let combos = 0, checkedMenu = 0;
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
  if (!sent) { ok(false, `${tag}: no sentiment request`); continue; }
  const ids = Object.keys(sent.questions.sentiment.criteria).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  ok(JSON.stringify(ids) === JSON.stringify(want), `${tag}: moods ${ids} want ${want} (C ${C})`);
  ok(ids.length === want.length && ids.includes('steady'), `${tag}: option count ${ids.length}`);
  ok(String(sent.state.self.confidence).startsWith(`${Math.floor(C)} `), `${tag}: self.confidence ${sent.state.self.confidence}, C ${C}`);
  const menu = first?.decision?.tactic?.options;
  if (menu) {
    checkedMenu++;
    ok('run_away' in menu, `${tag}: run_away missing from the tactic menu ${Object.keys(menu)}`);
    ok('engage' in menu, `${tag}: engage missing from the tactic menu ${Object.keys(menu)}`);
  }
}
for (const [n, hp, L, H, want] of SPOTS) {
  const C = combine(capability({ lives: L, maxLives: L, steady: true, armed: true, ghosts: Array.from({ length: n }, () => ({ hp, weight: 1 })) }), H, L, L);
  ok(C === want, `spot ${n} ghosts hp ${hp} lives ${L}: C ${C} want ${want}`);
}
ok(combos === 3 * 3 * 3 * 3 * 2 && checkedMenu > 60, `matrix ran ${combos} combos, ${checkedMenu} tactic menus`);

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

// ---- 3. hysteresis: C 35 offers bold only to a brain whose mood is already bold ----
// 3 ghosts hp 2, H 27 (h -21): lives 4 -> C 45, lives 3 -> C 36, lives 2 -> C 22.
{
  const logA = [];
  const a = make({ H: 29, log: logA });
  await tick(a); // lives 4, C 45: bold offered and picked
  ok(logA.some((r) => r.kind === 'sentiment' && 'bold' in r.questions.sentiment.criteria), 'hysteresis: bold offered at C 45');
  ok(a.memory.sentiment.id === 'bold', `hysteresis: bold picked at C 45 (got ${a.memory.sentiment.id})`);
  a.game.health = 3; // C 36: past the threshold by 5, the current mood stays
  const n0 = logA.length;
  for (let i = 0; i < 4; i++) await tick(a);
  const decided = logA.slice(n0).filter((r) => r.kind === 'sentiment');
  ok(decided.every((r) => 'bold' in r.questions.sentiment.criteria), 'hysteresis: bold stays offered to a bold brain at C 36');
  ok(!logA.slice(n0).some((r) => /Your confidence changed/.test(JSON.stringify(r.questions))), 'hysteresis: no confidence trigger inside the band');
  const logB = [];
  const b = make({ H: 29, lives: 3, log: logB, pick: (k) => (k.includes('steady') ? 'steady' : k[0]) });
  await tick(b); // lives 3, C 35, mood steady: bold is not offered
  const k = sentimentKeys(logB)[0];
  ok(k && !k.includes("bold") && !k.includes("wary") && k.includes("greedy"), `hysteresis: a steady brain at C 36 is offered greedy and neither wary nor bold (got ${k})`);
}

// ---- 4. the confidence trigger: once per encounter per direction ----
{
  const log = [];
  const r = make({ H: 29, log });
  r.game.adversaries.forEach((a) => { a.mode = "chase"; }); // no patrol->chase encounter trigger in the way
  await tick(r); // C 45, bold
  r.game.health = 2; // C 22: bold and greedy closed
  const triggers = [];
  for (let i = 0; i < 12 && !r.game.lost; i++) { const t = await tick(r); if (t.decision) triggers.push(t.decision.trigger); }
  const n = triggers.filter((x) => x === 'confidence').length;
  ok(n === 1, `confidence trigger fires exactly once per encounter (got ${n}: ${triggers})`);
  const after = sentimentKeys(log).at(-1);
  ok(after && !after.includes('bold') && !after.includes('greedy'), `after the cap closed bold the question lists ${after}`);
  ok(log.some((q) => q.kind === 'sentiment' && /Your confidence changed enough/.test(q.questions.sentiment.instructions)), 'the confidence trigger text is in the sentiment question');
}

// ---- 5. out of sight: a silent swap to steady ----
{
  const log = [];
  const r = make({ H: 40, lives: 2, maxLives: 2, ghosts: [[9, 3], [9, 2], [9, 4]], log, pick: (k) => (k.includes('wary') ? 'wary' : k[0]) });
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
  const stakes = /usually costs at most one life/;
  const dflt = /Default: engage while the sword is ready \(you act first; hold off the nearest\)/;
  const text = (sent) => sent.map((r) => JSON.stringify(r.questions)).join('\n');
  for (const [name, o, wantClaim] of [
    ['2 ghosts', { ghosts: cells[2] }, true],
    ['3 ghosts', { ghosts: cells[3] }, true],
    ['3 ghosts at speed 1', { ghosts: cells[3], settings: { speed: 1 } }, false],
    ['4 ghosts', { ghosts: [[9, 3], [9, 2], [9, 4], [10, 3]] }, false],
    ['2 ghosts hp 4', { ghosts: cells[2], ghostHp: 4 }, false],
    ['2 ghosts, claw damage 2 at 2 lives', { ghosts: cells[2], health: 2, settings: { clawDamage: 2 } }, false],
    ['2 ghosts, stun 1 (not steady)', { ghosts: cells[2], settings: { stunTicks: 1 } }, false],
    ['2 ghosts, sword cooldown 2 (not steady)', { ghosts: cells[2], settings: { swordCooldown: 2 } }, false],
    ['2 ghosts at C below 40', { ghosts: cells[2], confidence: { caps: true, start: 20 }, health: 2 }, false],
  ]) {
    const t = text(await first({ confidence: { caps: true, start: 80 }, ghostHp: 2, health: 4, ...o }));
    ok(stakes.test(t) === wantClaim, `claim gate (${name}): stakes sentence ${stakes.test(t) ? 'present' : 'absent'}, want ${wantClaim ? 'present' : 'absent'}`);
    ok(!/outnumbered/.test(t), `no 'outnumbered' (${name})`);
  }
  // the default line on a decision tick with the tactic question (steady mood, 2 ghosts, fight on)
  {
    const sent = await first({ ghosts: cells[2], ghostHp: 2, health: 4, confidence: { caps: true, start: 80 }, mood: 'steady' });
    ok(sent.some((r) => dflt.test(JSON.stringify(r.questions))), 'default engage line for 2 ghosts (steady, fight on)');
    ok(!sent.some((r) => /Default: engage a lone adversary/.test(JSON.stringify(r.questions))), 'no lone-adversary default line with 2 ghosts');
  }
  // one ghost: today's lone-fight wording
  {
    const t = text(await first({ ghosts: cells[1], ghostHp: 2, health: 2, confidence: { caps: true, start: 80 }, mood: 'steady' }));
    ok(/Default: engage a lone adversary/.test(t) && /A lone adversary you can strike first/.test(t), "one ghost keeps today's lone-fight wording in caps mode");
  }
  for (const g of [cells[3], [[9, 3], [9, 2], [9, 4], [10, 3]]]) {
    await playDuel({ ghosts: g, ghostHp: 2, health: 4, maxTicks: 25, confidence: { caps: true, start: 50 }, onAsk: (r) => bodies.push(r.body) });
  }
  ok(bodies.length > 20 && !bodies.some((b) => /outnumbered/.test(b)), `no 'outnumbered' in ${bodies.length} caps-mode requests`);
  // caps off: none of the caps wording, and the old text is intact
  const off = [];
  await playDuel({ ghosts: cells[2], ghostHp: 2, health: 4, maxTicks: 6, onAsk: (r) => off.push(r.body) });
  const offText = off.join('\n');
  ok(/outnumbered/.test(offText), 'caps off: the old wary text still says outnumbered');
  ok(!/Only the moods your confidence allows|it decides which moods are offered|usually costs at most one life|self\.confidence/.test(offText), 'caps off: no caps wording, no self.confidence');
  const sentBody = off.map((b) => JSON.parse(b)).find((b) => b.questions.sentiment);
  ok(Object.keys(sentBody?.questions.sentiment.criteria ?? {}).length === 4, 'caps off: 4 moods');
  ok(ORDER.every((id) => id in SENTIMENTS), 'SENTIMENTS unchanged');
}

rmSync(dir, { recursive: true, force: true });
if (fails) { console.log(`check-confidence-caps: ${fails} failure(s)`); process.exit(1); }
console.log('check-confidence-caps: ok');
