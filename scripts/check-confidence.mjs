// Checks for src/characters/explorer/confidence.js (PLAN-confidence C1): cap table, clamps, ceilings,
// calm drift, bands, neutral-zone identity, a quiet game's range, determinism, JSON round-trip, purity.
// Free, no Jev.
import { readFileSync } from 'node:fs';
import { createConfidence, apply, cap, calm, band, gaps, engageOpen, applyTurn } from '../src/characters/explorer/confidence.js';

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
ok(apply(at(50), 'hit', 2, 3).value === 35, 'hit from 50: 35');
ok(apply(at(50), 'hit', 1, 2).value === 35, 'hit from 50 on last life: 35 (under the cap)');
ok(apply(at(10), 'hit', 1, 2).value === 0, 'hit never goes below 0');
ok(apply(at(100), 'dispelled', 2, 2).value === 100, 'never above 100');
ok(apply(at(95), 'struck', 1, 2).value === 45, 'cap applies after a gain too');

// 3. ceiling 65 for evaded / blocked, and they never pull a higher C down
let s = at(64);
for (let i = 0; i < 5; i++) { s = apply(s, 'evaded', 2, 2); s = apply(s, 'blocked', 2, 2); }
ok(s.value === 65, `evaded/blocked stop at 65, got ${s.value}`);
ok(apply(at(78), 'evaded', 2, 2).value === 78 && apply(at(78), 'blocked', 2, 2).value === 78, 'above 65 evaded/blocked leave C alone');
ok(apply(at(50), 'evaded', 2, 2).value === 54 && apply(at(50), 'blocked', 2, 2).value === 53, 'evaded +4, blocked +3');

// 4. calm drift: only below 50, never above
ok(apply(at(35), 'calm', 2, 2).value === 35.3, 'calm +0.3 below 50');
ok(apply(at(49.9), 'calm', 2, 2).value === 50, 'calm stops at 50');
ok(apply(at(50), 'calm', 2, 2).value === 50 && apply(at(70), 'calm', 2, 2).value === 70, 'no calm drift at or above 50');
s = at(35);
let n = 0;
while (s.value < 40) { s = calm(s); n++; }
ok(n >= 16 && n <= 17, `about 17 calm steps from 35 to engage-open, got ${n}`);
for (let v = 0; v <= 100; v += 5) {
  const c = calm(at(v)).value;
  ok(c >= v && (v >= 50 ? c === v : c <= 50), `calm at ${v}: ${c}`);
}

// 5. bands
const B = [[0, 'shaken'], [29.9, 'shaken'], [30, 'unsure'], [39.9, 'unsure'], [40, 'even'], [64.9, 'even'], [65, 'sure'], [79.9, 'sure'], [80, 'dominant'], [100, 'dominant']];
for (const [v, b] of B) ok(band(v) === b, `band(${v}) = ${band(v)}, want ${b}`);

// 6. gaps / engageOpen: identity over the neutral zone, steps outside it
for (let v = 40; v < 80; v += 0.5) ok(gaps(v) === 0 && engageOpen(v), `neutral zone identity at ${v}`);
ok(gaps(39.9) === 1 && gaps(30) === 1 && gaps(29.9) === 2 && gaps(0) === 2 && gaps(80) === -1 && gaps(100) === -1, 'gap steps');
ok(!engageOpen(39.9) && engageOpen(40), 'engage threshold 40');

// 7. a quiet game (no hit, no kill) stays within 42..65
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
let quietBad = 0;
for (let g = 0; g < 200; g++) {
  let q = createConfidence();
  for (let t = 0; t < 300; t++) {
    const r = rnd();
    q = apply(q, r < 0.4 ? 'calm' : r < 0.6 ? 'pressed' : r < 0.8 ? 'evaded' : 'blocked', 2, 2);
    if (q.value < 42 || q.value > 65) quietBad++;
    if (rnd() < 0.05) q = { ...q, enc: { chased: false, hurt: false, killed: false, pressed: 0 } }; // a new encounter
  }
}
ok(quietBad === 0, `quiet games left 42..65 ${quietBad} times`);
s = createConfidence();
for (let i = 0; i < 10; i++) s = apply(s, 'pressed', 2, 2);
ok(s.value === 42, `pressed capped at -8 per encounter: ${s.value}`);

// 8. determinism, no mutation, JSON round-trip, unknown event
const run = () => { let x = createConfidence(); for (const e of ['struck', 'hit', 'calm', 'dispelled', 'evaded', 'pressed', 'blocked']) x = apply(x, e, 2, 3); return x; };
ok(JSON.stringify(run()) === JSON.stringify(run()), 'deterministic');
const frozen = JSON.stringify(at(50));
apply(at(50), 'hit', 2, 2);
ok(JSON.stringify(at(50)) === frozen, 'apply does not mutate');
const r1 = run();
const r2 = JSON.parse(JSON.stringify(r1));
ok(JSON.stringify(r2) === JSON.stringify(r1) && apply(r2, 'calm', 2, 3).value === apply(r1, 'calm', 2, 3).value, 'JSON round-trip');
let threw = false;
try { apply(at(50), 'bogus', 2, 2); } catch { threw = true; }
ok(threw, 'unknown event throws');

// 9. applyTurn from the turn shape
const ch = [{ id: 'a1', distance: 5, mode: 'chase' }];
const ctx = { lives: 2, maxLives: 2 };
const struck = { id: 'a1', type: 'struck', hp: 1 };
let t = applyTurn(createConfidence(), { skill_events: [struck], events: [struck] }, { ...ctx, visible: ch });
ok(t.value === 56, `struck turn counted once: ${t.value}`);
t = applyTurn(createConfidence(), { skill_events: [{ id: 'a1', type: 'dispelled' }], events: [{ id: 'a1', type: 'dispelled' }] }, { ...ctx, visible: [] });
ok(t.value === 62 && t.enc.killed, `dispelled turn: ${t.value}`);
t = applyTurn(createConfidence(), { events: [{ id: 'a1', type: 'hit', at: [1, 1], health: 1 }] }, { lives: 1, maxLives: 2, visible: ch });
ok(t.value === 35 && t.enc.hurt, `hit turn: ${t.value}`);
t = applyTurn(createConfidence(), { events: [{ id: 'a1', type: 'blocked' }] }, { ...ctx, visible: ch });
ok(t.value === 53, `blocked turn: ${t.value}`);
t = applyTurn(createConfidence(), {}, { ...ctx, visible: ch });
t = applyTurn(t, { decision: { trigger: 'chase_over' } }, { ...ctx, visible: [] });
ok(t.counts.evaded === 1 && t.value === 54, `evaded: ${t.value}`);
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
ok(applyTurn(at(40), {}, { ...ctx, visible: [] }).value === 40.3, 'calm turn drift');

// 10. purity: no imports, no Math.random, no Date
const src = readFileSync(new URL('../src/characters/explorer/confidence.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
ok(!/^\s*import\s/m.test(src) && !/\bimport\s*\(/.test(src) && !/\brequire\s*\(/.test(src), 'confidence.js has no imports');
ok(!/Math\.random|\bDate\b|performance\./.test(src), 'confidence.js uses no Math.random / Date');

if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
console.log('check-confidence: all checks passed');
