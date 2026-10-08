// Check: every explorer request over the request-hash scenarios (scripts/request-hashes.mjs) matches the baseline in
// scripts/fixtures/request-hashes.json (confidence caps is the only model since PLAN-moods). A mismatch prints the
// scenario, tick, request number and the first differing key path (depth 2). Free, no Jev. Regenerate the baseline
// only on purpose, in its own commit:  node scripts/request-hashes.mjs --write
import { readFileSync } from 'node:fs';
import { computeAll, FIXTURE } from './request-hashes.mjs';

const base = JSON.parse(readFileSync(FIXTURE, 'utf8')).scenarios;
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

compare('requests', await computeAll());
const n = Object.values(base).reduce((sum, v) => sum + v.requests.length, 0);
if (fails) { console.log(`check-request-hashes: ${fails} failure(s)`); process.exit(1); }
console.log(`check-request-hashes: ok (${Object.keys(base).length} scenarios, ${n} requests)`);
