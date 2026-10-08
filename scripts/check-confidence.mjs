// Checks for src/characters/explorer/confidence.js (PLAN-confidence C1): cap table, clamps, ceilings,
// bands, neutral-zone identity, a quiet game's range, determinism, JSON round-trip, purity.
// Free, no Jev.
import { readFileSync } from 'node:fs';
import { SENTIMENTS } from '../src/characters/explorer/brain.js';
import { createConfidence, apply, cap, band, applyTurn, WEIGHTS, REGEN, REGEN_WAIT, tierOf, panicNext, capability, combine, allowedMoods, defaultMood, tierOfMood, sightWeight, W_PER_EXTRA, W_PER_EXTRA_SAFE, HIST_SPAN, NO_SWORD_MAX } from '../src/characters/explorer/confidence.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(`FAIL: ${m}`); } };
const at = (v) => ({ ...createConfidence(), value: v });

// 1. cap table (PLAN-confidence section 1)
const TABLE = { 1: [100], 2: [100, 45], 3: [100, 77, 45], 4: [100, 83, 65, 45] };
for (let m = 1; m <= 9; m++) {
  for (let l = 1; l <= m; l++) {
    const c = cap(l, m);
    if (TABLE[m]) ok(c === TABLE[m][m - l], `cap(${l},${m}) = ${c}, table ${TABLE[m][m - l]}`);
    if (m > 1 && l === 1) ok(c === 45, `last life cap ${m}: ${c}`);
    if (l === m) ok(c === 100, `full lives cap ${m}: ${c}`);
    if (l < m) ok(c <= cap(l + 1, m), `cap monotone in lives (${l},${m})`);
  }
}

// 2. clamp after a hit
ok(apply(at(95), 'hit', 1, 2).value === 45, 'hit from 95 on the last life clamps to 45');
ok(apply(at(50), 'hit', 2, 3).value === 43, 'hit from 50: 43');
ok(apply(at(50), 'hit', 1, 2).value === 43, 'hit from 50 on last life: 43 (under the cap)');
ok(apply(at(5), 'hit', 1, 2).value === 0, 'hit never goes below 0');
ok(apply(at(100), 'dispelled', 2, 2).value === 100, 'never above 100');
ok(apply(at(95), 'struck', 1, 2).value === 45, 'cap applies after a gain too');

// 3. ceiling 65 for evaded / blocked, and they never pull a higher C down
let s = at(64);
for (let i = 0; i < 5; i++) { s = apply(s, 'evaded', 2, 2); s = apply(s, 'blocked', 2, 2); }
ok(s.value === 65, `evaded/blocked stop at 65, got ${s.value}`);
ok(apply(at(78), 'evaded', 2, 2).value === 78 && apply(at(78), 'blocked', 2, 2).value === 78, 'above 65 evaded/blocked leave C alone');
ok(apply(at(50), 'evaded', 2, 2).value === 52 && apply(at(50), 'blocked', 2, 2).value === 53, 'evaded +2, blocked +3');

// 4. (calm drift removed: PLAN-moods regen is section 13)
s = at(35);

// 5. bands
const B = [[0, 'shaken'], [29.9, 'shaken'], [30, 'unsure'], [39.9, 'unsure'], [40, 'even'], [64.9, 'even'], [65, 'sure'], [79.9, 'sure'], [80, 'dominant'], [100, 'dominant']];
for (const [v, b] of B) ok(band(v) === b, `band(${v}) = ${band(v)}, want ${b}`);

// 7. a quiet game (no hit, no kill) stays within 40..65 (evaded is +2 now, so pressed encounters recover more slowly)
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
let quietBad = 0;
for (let g = 0; g < 200; g++) {
  let q = createConfidence();
  for (let t = 0; t < 300; t++) {
    const r = rnd();
    q = apply(q, r < 0.4 ? 'regen' : r < 0.6 ? 'pressed' : r < 0.8 ? 'evaded' : 'blocked', 2, 2);
    if (q.value < 40 || q.value > 65) quietBad++;
    if (rnd() < 0.05) q = { ...q, enc: { chased: false, hurt: false, killed: false, pressed: 0 } }; // a new encounter
  }
}
ok(quietBad === 0, `quiet games left 40..65 ${quietBad} times`);
s = createConfidence();
for (let i = 0; i < 10; i++) s = apply(s, 'pressed', 2, 2);
ok(s.value === 42, `pressed capped at -8 per encounter: ${s.value}`);

// 8. determinism, no mutation, JSON round-trip, unknown event
const run = () => { let x = createConfidence(); for (const e of ['struck', 'hit', 'regen', 'dispelled', 'evaded', 'pressed', 'blocked']) x = apply(x, e, 2, 3); return x; };
ok(JSON.stringify(run()) === JSON.stringify(run()), 'deterministic');
const frozen = JSON.stringify(at(50));
apply(at(50), 'hit', 2, 2);
ok(JSON.stringify(at(50)) === frozen, 'apply does not mutate');
const r1 = run();
const r2 = JSON.parse(JSON.stringify(r1));
ok(JSON.stringify(r2) === JSON.stringify(r1) && apply(r2, 'regen', 2, 3).value === apply(r1, 'regen', 2, 3).value, 'JSON round-trip');
let threw = false;
try { apply(at(50), 'bogus', 2, 2); } catch { threw = true; }
ok(threw, 'unknown event throws');

// 9. applyTurn from the turn shape
const ch = [{ id: 'a1', distance: 5, mode: 'chase' }];
const ctx = { lives: 2, maxLives: 2 };
const struck = { id: 'a1', type: 'struck', hp: 1 };
let t = applyTurn(createConfidence(), { skill_events: [struck], events: [struck] }, { ...ctx, visible: ch });
ok(t.value === 55, `struck turn counted once: ${t.value}`);
t = applyTurn(createConfidence(), { skill_events: [{ id: 'a1', type: 'dispelled' }], events: [{ id: 'a1', type: 'dispelled' }] }, { ...ctx, visible: [] });
ok(t.value === 58 && t.enc.killed, `dispelled turn: ${t.value}`);
t = applyTurn(createConfidence(), { events: [{ id: 'a1', type: 'hit', at: [1, 1], health: 1 }] }, { lives: 1, maxLives: 2, visible: ch });
ok(t.value === 43 && t.enc.hurt, `hit turn: ${t.value}`);
t = applyTurn(createConfidence(), { events: [{ id: 'a1', type: 'blocked' }] }, { ...ctx, visible: ch });
ok(t.value === 53, `blocked turn: ${t.value}`);
t = applyTurn(createConfidence(), {}, { ...ctx, visible: ch });
t = applyTurn(t, { decision: { trigger: 'chase_over' } }, { ...ctx, visible: [] });
ok(t.counts.evaded === 1 && t.value === 52, `evaded: ${t.value}`);
t = applyTurn(createConfidence(), { events: [{ type: 'hit' }] }, { lives: 1, maxLives: 2, visible: ch });
t = applyTurn(t, { decision: { trigger: 'chase_over' } }, { lives: 1, maxLives: 2, visible: [] });
ok(t.counts.evaded === 0 && !t.enc.hurt, 'hurt encounter is not evaded; encounter closed');
t = applyTurn(createConfidence(), { decision: { trigger: 'chase_over' } }, { ...ctx, visible: [] });
ok(t.counts.evaded === 0, 'chase_over with no chasing sighting is not evaded');
const close = [{ id: 'a1', distance: 2, mode: 'chase' }];
ok(applyTurn(createConfidence(), {}, { ...ctx, visible: close, armed: false }).value === 48, 'pressed -2');
ok(applyTurn(createConfidence(), {}, { ...ctx, visible: close, armed: true }).value === 50, 'armed: not pressed');
ok(applyTurn(createConfidence(), {}, { ...ctx, visible: close, armed: false, engaging: true }).value === 50, 'engaging: not pressed');
ok(applyTurn(createConfidence(), {}, { ...ctx, visible: close, armed: false, stunned: ['a1'] }).value === 50, 'stunned: not pressed');
ok(applyTurn(at(40), {}, { ...ctx, visible: [] }).value === 40 && applyTurn(at(40), {}, { ...ctx, visible: [] }).idle === 1, 'a quiet turn counts toward the regen wait');
ok(applyTurn({ ...at(40), idle: REGEN_WAIT }, {}, { ...ctx, visible: close }).value === 40.25, 'regen runs with an enemy in sight too');

// 11. C4 arms: the default state shape is unchanged; weights override; the beta model is the posterior
ok(JSON.stringify(Object.keys(createConfidence())) === '["value","idle","counts","enc"]', 'default state has no w / model keys');
ok(apply(createConfidence(), 'hit', 2, 3).value === 43, 'default weights: hit -7');
let wv = createConfidence({ weights: { hit: -25 } });
ok(wv.w.hit === -25 && wv.w.struck === WEIGHTS.struck, 'weights merge over the defaults');
ok(apply(wv, 'hit', 2, 3).value === 25 && apply(apply(wv, 'hit', 2, 3), 'regen', 2, 3).value === 25, 'custom hit weight (regen waits)');
ok(apply(wv, 'hit', 2, 3).w === wv.w, 'weights survive apply');
let bt = createConfidence({ model: 'beta' });
ok(bt.value === 50, 'beta starts at 50');
bt = apply(bt, 'hit', 2, 3);
ok(Math.abs(bt.value - 40) < 0.01, `beta after one hit is 2/5: ${bt.value}`);
bt = apply(apply(bt, 'struck', 2, 3), 'dispelled', 2, 3);
ok(Math.abs(bt.value - 100 * 4 / 7) < 0.01, `beta after hit, 2 landed is 4/7: ${bt.value}`);
const bt2 = apply(apply(bt, 'regen', 2, 3), 'pressed', 2, 3);
ok(bt2.value === bt.value, 'beta ignores regen and pressed');
ok(apply(createConfidence({ model: 'beta' }), 'hit', 1, 2).value === 40 && apply(apply(createConfidence({ model: 'beta' }), 'struck', 1, 2), 'struck', 1, 2).value === 45, 'beta obeys the lives cap');
ok(JSON.stringify(JSON.parse(JSON.stringify(bt))) === JSON.stringify(bt), 'beta state round-trips through JSON');

// 12. PLAN-confidence-mood phase 1: capability R, combine, allowedMoods, sightWeight
{
  const g2 = (n, hp = 2) => Array.from({ length: n }, () => ({ hp, weight: 1 }));
  const cap0 = (L, M, n, w, extra = {}) => capability({ lives: L, maxLives: M, ghosts: g2(n), ...extra }, w);
  const C0 = (L, M, n, w) => combine(cap0(L, M, n, w), 50, L, M);
  // (a) the section 2.2 table (rows: lives left of max; columns: 0..4 ghosts of 2 hp), history neutral
  const T05 = { '2/2': [67, 67, 50, 33, 17], '3/3': [70, 70, 58, 45, 33], '4/4': [70, 70, 60, 50, 40], '1/2': [45, 45, 25, 0, 0] };
  const T035 = { '2/2': [67, 67, 55, 43, 32], '3/3': [70, 70, 61, 53, 44], '4/4': [70, 70, 63, 56, 49], '1/2': [45, 45, 33, 15, 0] };
  const B035 = { '2/2': ['sure', 'sure', 'even', 'even', 'unsure'], '3/3': ['sure', 'sure', 'even', 'even', 'even'], '4/4': ['sure', 'sure', 'even', 'even', 'even'], '1/2': ['even', 'even', 'unsure', 'shaken', 'shaken'] };
  const B05 = { '2/2': ['sure', 'sure', 'even', 'unsure', 'shaken'], '3/3': ['sure', 'sure', 'even', 'even', 'unsure'], '4/4': ['sure', 'sure', 'even', 'even', 'even'], '1/2': ['even', 'even', 'shaken', 'shaken', 'shaken'] };
  ok(W_PER_EXTRA === 0.35 && W_PER_EXTRA_SAFE === 0.5, 'W_PER_EXTRA 0.35, W_PER_EXTRA_SAFE 0.5');
  ok(cap0(2, 2, 3) === cap0(2, 2, 3, W_PER_EXTRA), 'default wPerExtra is W_PER_EXTRA');
  for (const [w, T, B] of [[0.5, T05, B05], [0.35, T035, B035]]) {
    for (const key of Object.keys(T)) {
      const [L, M] = key.split('/').map(Number);
      for (let n = 0; n <= 4; n++) {
        const c = C0(L, M, n, w);
        ok(c === T[key][n], `w ${w} lives ${key} ${n} ghosts: C ${c}, want ${T[key][n]}`);
        ok(band(c) === B[key][n], `w ${w} lives ${key} ${n} ghosts: band ${band(c)}, want ${B[key][n]}`);
      }
    }
  }
  ok(C0(2, 2, 3, 0.35) >= 40 && C0(2, 2, 3, 0.5) < 40, 'three 2-hp ghosts at 2 lives: even at 0.35, unsure at 0.5');
  ok(combine(capability({ lives: 2, maxLives: 2, ghosts: g2(2, 1) }, 0.5), 50, 2, 2) === 54 && combine(capability({ lives: 2, maxLives: 2, ghosts: g2(2, 3) }, 0.5), 50, 2, 2) === 46, 'two 1-hp ghosts 54, two 3-hp ghosts 46 (w 0.5)');
  ok(combine(cap0(2, 2, 2, 0.5), 68, 2, 2) === 68 && combine(cap0(2, 2, 2, 0.5), 80, 2, 2) === 80, 'history shifts C: H 68 / 80 with two ghosts at 2 lives read 68 / 80 (w 0.5)');
  ok(cap0(2, 2, 1, 0.5, { steady: false }) === 50 && cap0(2, 2, 1, 0.5) === 67, 'non-steady: the first ghost costs too (assumption)');
  ok(cap0(2, 2, 0, 0.5, { steady: false }) === 67, 'no ghost known: R is the explorer\'s own strength');
  // (b) monotonicity over a grid
  for (const w of [0.35, 0.5]) for (const steady of [true, false]) for (const hp of [1, 2, 3, 5]) {
    for (let M = 1; M <= 6; M++) for (let L = 1; L <= M; L++) {
      const R = (n, h, l = L) => capability({ lives: l, maxLives: M, ghosts: g2(n, h), steady }, w);
      let prev = 101;
      for (let n = 0; n <= 8; n++) {
        ok(R(n, hp) <= prev, `more ghosts never raises R (w ${w} steady ${steady} hp ${hp} L ${L} n ${n})`);
        prev = R(n, hp);
      }
      if (L < M) for (let n = 0; n <= 5; n++) ok(R(n, hp) <= R(n, hp, L + 1), `more lives never lowers R (w ${w} L ${L} n ${n})`);
      for (let n = 1; n <= 5; n++) ok(R(n, hp + 1) <= R(n, hp), `higher hp never raises R (hp ${hp} L ${L} n ${n})`);
    }
  }
  ok(capability({ lives: 2, maxLives: 2, ghosts: [{ hp: 2, weight: 1 }, { hp: 2, weight: 0.5 }] }) >= cap0(2, 2, 2), 'a fading ghost weighs less than a visible one');
  ok(capability({ lives: 2, maxLives: 2, swordDamage: 2, ghosts: g2(2, 4) }) === cap0(2, 2, 2), 'strikes to dispel = ceil(hp / swordDamage)');
  // (c) clamps, the last-life cap through combine, no attack skill
  for (let L = 1; L <= 4; L++) for (let n = 0; n <= 12; n++) for (const w of [0.35, 0.5]) {
    const R = cap0(L, 4, n, w);
    ok(R >= 0 && R <= 100 && Number.isInteger(R), `R in 0..100 (L ${L} n ${n})`);
    for (const H of [0, 20, 50, 80, 100, 250, -40]) {
      const C = combine(R, H, L, 4);
      ok(C >= 0 && C <= 100 && C <= cap(L, 4), `C clamped (L ${L} n ${n} H ${H}): ${C}`);
    }
  }
  ok(combine(100, 100, 1, 2) === 45 && combine(90, 80, 1, 3) === 45 && combine(60, 50, 1, 1) === 60, 'last life caps C at 45 through combine (a single-life game is not capped)');
  ok(combine(0, 0, 2, 2) === 0 && combine(100, 100, 2, 2) === 100 && combine(50, 200, 2, 2) === 80, 'combine: floor 0, ceiling 100, h limited to +30');
  for (let L = 1; L <= 4; L++) for (let n = 0; n <= 4; n++) ok(cap0(L, 4, n, 0.35, { armed: false }) <= NO_SWORD_MAX, `no attack skill: R <= 20 (L ${L} n ${n})`);
  ok(NO_SWORD_MAX === 20 && cap0(2, 2, 3, 0.35, { armed: false }) === Math.min(20, cap0(2, 2, 3, 0.35)) && cap0(2, 2, 0, 0.35, { armed: false }) === 20, 'no sword: min(R, 20)');
  // (d) allowedMoods: the three tiers of PLAN-moods (low wary/guarded, mid cautious/steady/greedy, high bold/fearless)
  const LOW = 'wary,guarded', MID = 'cautious,steady,greedy', HIGH = 'bold,fearless';
  const ORDER = Object.keys(SENTIMENTS);
  ok(JSON.stringify(ORDER) === '["panic","wary","guarded","cautious","steady","greedy","bold","fearless"]', `SENTIMENTS order ${ORDER}`);
  for (let C = 0; C <= 100; C++) {
    const l = allowedMoods(C, {});
    ok(l.join() === (C <= 35 ? LOW : C <= 75 ? MID : HIGH), `allowedMoods(${C}) = ${l}`);
    ok(!l.includes('panic'), `panic is never offered (${C})`);
    ok(allowedMoods(C).join() === l.join(), `ctx is optional (${C})`);
    // hysteresis: the tier of the current mood is kept 5 points past its edge
    ok(allowedMoods(C, { current: 'wary' }).join() === (C <= 40 ? LOW : C <= 75 ? MID : HIGH), `low tier kept to 40 (C ${C})`);
    ok(allowedMoods(C, { current: 'panic' }).join() === allowedMoods(C, { current: 'wary' }).join(), `panic holds the low tier like wary (${C})`);
    ok(allowedMoods(C, { current: 'bold' }).join() === (C <= 35 ? LOW : C >= 71 ? HIGH : MID), `high tier kept down to 71 (C ${C})`);
    ok(allowedMoods(C, { current: 'steady' }).join() === l.join(), `a mid mood adds no hysteresis (${C})`);
    for (const ex of ['lastLife', 'swordDown']) ok(allowedMoods(C, { [ex]: true }).join() === LOW, `${ex} forces the low tier at ${C}`);
  }
  ok(defaultMood(['wary', 'guarded']) === 'guarded' && defaultMood(['cautious', 'steady', 'greedy']) === 'steady' && defaultMood(['bold', 'fearless']) === 'bold', 'defaultMood: guarded / steady / bold');
  ok(tierOfMood('panic') === 'low' && tierOfMood('fearless') === 'high' && tierOfMood('nope') === null, 'tierOfMood');
  // (e) sightWeight
  ok(sightWeight(0) === 1 && sightWeight(15) === 0.5 && sightWeight(30) === 0 && sightWeight(31) === 0 && sightWeight(500) === 0, 'sightWeight: 1, 0.5, 0, 0');
  ok(HIST_SPAN === 30, 'HIST_SPAN 30');
  for (let a = 0; a < 30; a++) ok(Math.abs(sightWeight(a) - sightWeight(a + 1) - 1 / 30) < 1e-12, `sightWeight linear at ${a}`);
  ok(sightWeight(-3) === 1, 'sightWeight clamps a negative age');
  // (f) determinism and JSON round-trip (the import / Math.random / Date scan is section 10)
  const inp = { lives: 2, maxLives: 3, clawDamage: 1, swordDamage: 1, steady: true, armed: true, ghosts: [{ hp: 2, weight: 1 }, { hp: 3, weight: 0.4 }] };
  const rt = JSON.parse(JSON.stringify(inp));
  ok(capability(inp) === capability(inp) && capability(inp) === capability(rt), 'capability: same input, same output, JSON round-trip');
  const frozenIn = JSON.stringify(inp);
  capability(inp);
  ok(JSON.stringify(inp) === frozenIn, 'capability does not mutate its input');
  ok(allowedMoods(33, { current: 'bold' }).join() === allowedMoods(33, JSON.parse(JSON.stringify({ current: 'bold' }))).join(), 'allowedMoods round-trip');
  ok(JSON.stringify(allowedMoods(50, {})) === JSON.stringify(JSON.parse(JSON.stringify(allowedMoods(50, {})))), 'allowedMoods returns plain JSON');
  console.log('capability table (start 70 at most), C at H 50 (rows lives/max, columns 0..4 ghosts of 2 hp):');
  for (const [w, T] of [[0.5, T05], [0.35, T035]]) for (const k of Object.keys(T)) console.log(`  w ${w}  ${k}: ${T[k].join(' ')}`);
}

// 13. PLAN-moods: regen (0.25 toward 50, only after REGEN_WAIT quiet ticks), tiers, panic
{
  let r = apply(at(20), 'hit', 2, 2); // 13, idle 0
  ok(r.value === 13 && r.idle === 0, 'a change restarts the wait');
  for (let i = 0; i < REGEN_WAIT; i++) r = apply(r, 'regen', 2, 2);
  ok(r.value === 13 && r.idle === REGEN_WAIT, `no regen during the first ${REGEN_WAIT} ticks`);
  r = apply(r, 'regen', 2, 2);
  ok(r.value === 13.25, 'regen +0.25 from below once the wait is over');
  r = apply(r, 'struck', 2, 2);
  ok(r.value === 18.25 && r.idle === 0, 'an event restarts the wait');
  let hi = { ...at(95), idle: REGEN_WAIT };
  hi = apply(hi, 'regen', 2, 2);
  ok(hi.value === 94.75, 'regen -0.25 from above');
  ok(apply({ ...at(50), idle: 99 }, 'regen', 2, 2).value === 50, 'regen stops at 50');
  ok(apply({ ...at(49.9), idle: 99 }, 'regen', 2, 2).value === 50, 'regen never overshoots 50');
  ok(apply({ ...at(95), idle: 99 }, 'blocked', 2, 2).value === 95 && apply({ ...at(95), idle: 99 }, 'blocked', 2, 2).idle === 99, 'an event that leaves C unchanged keeps the wait');
  ok(apply({ ...at(5), idle: 99 }, 'regen', 2, 2).idle === 100, 'regen does not restart its own wait');
  let t = { ...at(15), idle: REGEN_WAIT };
  let n = 0;
  while (t.value < 25) { t = apply(t, 'regen', 2, 2); n++; }
  ok(n === 40, `15 to 25 takes 40 regen ticks after the wait: ${n}`);
  ok(JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r), 'regen state round-trips through JSON');
  ok(apply(createConfidence({ model: 'beta' }), 'regen', 2, 2).value === 50, 'beta ignores regen');
  // tiers: low <= 35, mid 36..75, high > 75, with 5 points of hysteresis
  ok(tierOf(35) === 'low' && tierOf(36) === 'mid' && tierOf(75) === 'mid' && tierOf(76) === 'high', 'tier edges 35/36 and 75/76');
  ok(tierOf(40, 'low') === 'low' && tierOf(41, 'low') === 'mid', 'low tier kept up to 40');
  ok(tierOf(71, 'high') === 'high' && tierOf(70, 'high') === 'mid', 'high tier kept down to 71');
  ok(tierOf(40, 'mid') === 'mid' && tierOf(71, 'mid') === 'mid', 'hysteresis only holds the tier already in');
  // panic: enter below 20, leave at 25
  ok(!panicNext(20, false) && panicNext(19.75, false), 'panic enters below 20');
  ok(panicNext(24.75, true) && !panicNext(25, true), 'panic ends only at 25 or more');
  ok(!panicNext(22, false) && panicNext(22, true), 'panic hysteresis between 20 and 25');
}

// 10. purity: no imports, no Math.random, no Date
const src = readFileSync(new URL('../src/characters/explorer/confidence.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
ok(!/^\s*import\s/m.test(src) && !/\bimport\s*\(/.test(src) && !/\brequire\s*\(/.test(src), 'confidence.js has no imports');
ok(!/Math\.random|\bDate\b|performance\./.test(src), 'confidence.js uses no Math.random / Date');

if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
console.log('check-confidence: all checks passed');
