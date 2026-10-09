// Adversary character checks (src/characters/adversary/character.js): profile snapshots, standard equals
// today's constants, deterministic assignment, rng isolation from spawning, priority line, no leaks.
// No Jev, no game ticks. Run from the dungeon-game directory: node scripts/check-characters.mjs

globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { generateDungeon } from '../src/dungeon.js';
import { spawnAdversaries } from '../src/characters/adversary/adversary.js';
import { PRESETS, PRESET_IDS, SPECIAL_IDS, PRIORITY_MAX, TRAITS, WORDS, assignCharacters, charactersFor, profileOf, traitsOf } from '../src/characters/adversary/character.js';

let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures <= 25) console.error('FAIL:', msg);
};
const check = (ok, msg) => ok || fail(msg);

// 1. Standard reproduces today's numbers.
{
  const p = profileOf(traitsOf('standard'));
  const today = { chaseRange: 7, maxSearchTicks: 18, keepHuntingMin: 0.5, alertSteps: 24, sweepRadius: 10, cutMax: 24, restTicks: 3, homeRadius: 24,
    sightingsKept: 3, sightingTtl: 30, landmarksCap: 5, landmarkTtl: 120, eventTtl: 120, recentMoves: 6, recentCells: 8, seenTtl: 120, seenCap: 300, keepDistance: 0 };
  for (const [k, v] of Object.entries(today)) check(p[k] === v, `standard ${k}: ${p[k]} !== ${v}`);
  check(p.answersCalls && p.makesCalls && p.teamSight && p.preferredSearch === null, 'standard pack flags and no preferred search');
}

// 2. Profile snapshot per preset (the knobs that differ most), so a table edit is deliberate.
{
  const snap = (id) => { const p = profileOf(traitsOf(id)); return [p.chaseRange, p.restTicks, p.maxSearchTicks, p.keepHuntingMin, p.sweepRadius, p.cutMax, p.homeRadius, p.alertSteps, p.answersCalls, p.makesCalls, p.preferredSearch].map(String).join('|'); };
  const expected = {
    ancient_guardian: '7|0|32|0.3|14|36|14|8|false|false|cut_off',
    pack_stalker: '7|0|32|0.3|10|24|null|40|true|true|null',
    standard: '7|3|18|0.5|10|24|24|24|true|true|null',
    aggressive: '7|0|18|0.5|6|12|24|24|true|true|sweep_last_seen',
    pursuer: '7|3|32|0.3|10|24|24|24|true|true|null',
    ambusher: '7|3|18|0.5|14|36|14|24|true|true|cut_off',
    patient_hunter: '7|3|32|0.3|14|36|24|40|true|true|cut_off',
    short_sighted: '7|3|10|0.65|6|12|24|24|true|true|sweep_last_seen',
    timid: '5|6|10|0.65|6|12|14|8|false|false|sweep_last_seen',
    territorial: '7|0|18|0.5|10|24|14|8|false|false|null',
    rover: '7|3|10|0.65|6|12|null|24|true|true|sweep_last_seen',
  };
  check(PRESET_IDS.length === 11, '11 presets (two kind-specific personalities)');
  for (const id of PRESET_IDS) check(snap(id) === expected[id], `${id} snapshot ${snap(id)} !== ${expected[id]}`);
}

// 3. Priority line and words.
{
  const bannedNames = SPECIAL_IDS.flatMap((id) => [id, id.replace('_', ' ')]);
  for (const id of PRESET_IDS) {
    const p = profileOf(traitsOf(id));
    check(p.priority.length > 0 && p.priority.length <= PRIORITY_MAX, `${id}: priority line length ${p.priority.length}`);
    const text = `${p.priority} ${PRESETS[id].style} ${Object.values(p.words).join(' ')}`.toLowerCase();
    for (const n of bannedNames) check(!text.includes(n), `${id}: words leak preset name '${n}'`);
    check(!/\d/.test(`${PRESETS[id].style} ${Object.values(p.words).join(' ')}`), `${id}: digits in style or words`);
  }
  check(TRAITS.every((t) => WORDS[t].length === 3), 'three words per trait');
  let threw = false;
  try { profileOf({ aggression: 4 }); } catch { threw = true; }
  check(threw, 'trait level 4 throws');
}

// 4. Assignment: deterministic, independent of count, independent of dungeon rng.
{
  check(assignCharacters(5, 4, 'mixed').join() === assignCharacters(5, 4, 'mixed').join(), 'assignment deterministic');
  for (let seed = 1; seed <= 30; seed++) {
    const big = assignCharacters(seed, 12, 'mixed');
    for (const n of [1, 3, 8]) check(assignCharacters(seed, n, 'mixed').join() === big.slice(0, n).join(), `seed ${seed}: count ${n} re-rolled earlier ghosts`);
    check(new Set(big.slice(0, 8)).size === 8 && !big.includes('standard') || false, `seed ${seed}: first deck holds each special once`);
    check(assignCharacters(seed, 3, 'standard').every((c) => c === 'standard'), 'standard mode');
  }
  check(new Set(Array.from({ length: 30 }, (_, i) => assignCharacters(i + 1, 8, 'mixed').join())).size > 5, 'seeds produce different orders');
  check(charactersFor(['ambusher', 'timid'], 1, 5).join() === 'ambusher,timid,ambusher,timid,ambusher', 'list cycles in id order');
  check(charactersFor('rover', 1, 2).join() === 'rover,rover', 'single id');
  for (let seed = 1; seed <= 30; seed++) {
    const d1 = generateDungeon(seed), a1 = spawnAdversaries(d1);
    assignCharacters(seed, a1.length, 'mixed');
    const d2 = generateDungeon(seed), a2 = spawnAdversaries(d2);
    check(JSON.stringify(d1.tiles) === JSON.stringify(d2.tiles) && a1.map((a) => a.pos).join(';') === a2.map((a) => a.pos).join(';'), `seed ${seed}: assignment changed dungeon or spawns`);
  }
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('All character checks passed.');
