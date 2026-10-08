// Check: every explorer request over the request-hash scenarios (scripts/request-hashes.mjs) matches the baseline in
// scripts/fixtures/request-hashes.json, with the confidence toggle OFF (the default) and, once the toggle exists,
// with it ON as well, in its own way (PLAN-confidence C3 adds self.confidence and one sentence to the sentiment
// question): the ON run is diffed against the OFF run in memory, request by request, for as long as C stays in the
// neutral zone 40..79; once the request shows C outside it the gates are meant to differ and the scenario stops being
// compared. Compared requests must be identical after removing state.self.confidence and the sentence. A mismatch prints the scenario, tick, request number and the first
// differing key path (depth 2). Free, no Jev. Regenerate the baseline only on purpose, in its own commit:
//   node scripts/request-hashes.mjs --write
import { readFileSync } from 'node:fs';
import { computeAll, FIXTURE, FIXTURE_CAPS, playScenario, scenarios } from './request-hashes.mjs';
import { CONFIDENCE_SENTENCE } from '../src/characters/explorer/brain.js';

let base = JSON.parse(readFileSync(FIXTURE, 'utf8')).scenarios;
let fails = 0;

function compare(label, got) {
  for (const name of Object.keys(base)) {
    if (!got[name]) { fails++; console.log(`FAIL: [${label}] scenario ${name} was not played`); continue; }
    const want = base[name].requests, have = got[name].requests;
    let bad = false;
    for (let i = 0; i < Math.max(want.length, have.length) && !bad; i++) {
      const w = want[i], h = have[i];
      if (!w || !h) {
        bad = true; fails++;
        console.log(`FAIL: [${label}] ${name}: ${w ? 'request ' + i + ' (tick ' + w[0] + ') is missing' : 'extra request ' + i + ' at tick ' + h[0]} (baseline ${want.length} requests, now ${have.length})`);
        break;
      }
      if (w[2] === h[2] && w[3] === h[3]) continue;
      bad = true; fails++;
      const paths = [...new Set([...Object.keys(w[4]), ...Object.keys(h[4])])];
      const diff = paths.find((p) => w[4][p] !== h[4][p]);
      const why = w[2] === h[2] ? 'same content, different key or option order' : diff ? `first differing key path: ${diff}${w[4][diff] === undefined ? ' (new)' : h[4][diff] === undefined ? ' (gone)' : ''}` : 'no depth-2 part differs';
      console.log(`FAIL: [${label}] ${name}: request ${i} (${w[1] === 's' ? 'sentiment' : 'tick'}, tick ${w[0]}) differs; ${why}`);
    }
    if (!bad && base[name].outcome !== got[name].outcome) { fails++; console.log(`FAIL: [${label}] ${name}: outcome ${got[name].outcome}, baseline ${base[name].outcome}`); }
  }
  for (const name of Object.keys(got)) if (!base[name]) { fails++; console.log(`FAIL: [${label}] scenario ${name} is not in the baseline`); }
}

compare('confidence off', await computeAll());
const nOff = Object.values(base).reduce((s, v) => s + v.requests.length, 0);
// Caps mode has its own fixture (scripts/fixtures/request-hashes-caps.json, written on purpose: node scripts/request-hashes.mjs --caps --write).
base = JSON.parse(readFileSync(FIXTURE_CAPS, 'utf8')).scenarios;
compare('confidence caps', await computeAll({ confidence: 'caps' }));
const nCaps = Object.values(base).reduce((s, v) => s + v.requests.length, 0);

// Toggle on, neutral zone: identical to the toggle-off run once the two additions are removed.
let neutral = 0, left = 0;
const strip = (body) => {
  const b = JSON.parse(JSON.stringify(body));
  delete b.state?.self?.confidence;
  const ins = b.questions?.sentiment?.instructions;
  if (typeof ins === 'string') b.questions.sentiment.instructions = ins.replace(CONFIDENCE_SENTENCE, '');
  return JSON.stringify(b);
};
for (const sc of scenarios()) {
  const off = await playScenario(sc, {}, { keepBodies: true });
  const on = await playScenario(sc, { confidence: true }, { keepBodies: true });
  let i = 0;
  for (; i < on.records.length; i++) {
    const conf = on.records[i].body.state?.self?.confidence;
    if (typeof conf !== 'string') { fails++; console.log(`FAIL: [confidence on] ${sc.name}: request ${i} has no self.confidence`); break; }
    const c = parseInt(conf, 10);
    if (c < 40 || c >= 80) { left++; break; }
    if (!off.records[i] || strip(on.records[i].body) !== JSON.stringify(off.records[i].body)) {
      fails++; console.log(`FAIL: [confidence on] ${sc.name}: request ${i} differs from the toggle-off run in the neutral zone (C ${conf})`); break;
    }
    neutral++;
  }
}
if (neutral < 100) { fails++; console.log(`FAIL: only ${neutral} neutral-zone requests compared`); }
console.log(`toggle on: ${neutral} neutral-zone requests identical to toggle off; ${left} scenarios left the zone (not compared further)`);
if (fails) { console.log(`check-request-hashes: ${fails} failure(s)`); process.exit(1); }
console.log(`check-request-hashes: ok (${Object.keys(base).length} scenarios: ${nOff} requests with the toggle off, ${nCaps} in caps mode; neutral-zone identity with the model on)`);
