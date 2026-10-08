// Monster morale, the pure model (src/characters/adversary/morale.js). Free: no Jev, no game, no fetch.
// Mirrors check-confidence.mjs section for section: hp cap, clamps, ceilings, per-hunt caps, regen,
// capability, combine, tiers, moods, rout, determinism, purity, the config hook.
import { strict as assert } from 'node:assert';
import {
  BANDS, CAPABILITY_MAX, D_CLAWED, D_WOUNDED, DEFAULT_MOOD, EVENT_IDS, LAST_HP_CAP, MOODS, MOOD_IDS, ROUT_ENTER, ROUT_EXIT, SLIPPED_MAX,
  TIER_HIGH_MIN, TIER_HYST, TIER_LOW_MAX, TIER_MOODS, apply, band, cap, capability, combine, configureMorale, createMorale, moodFor, moodKnobs,
  moraleOf, moraleSnapshot, routNext, startHunt,
} from '../src/characters/adversary/morale.js';
import { profileOf, traitsOf } from '../src/characters/adversary/character.js';

globalThis.fetch = () => { throw new Error('check-morale must never call out'); };

let fails = 0;
const check = (ok, what) => { if (ok) console.log(`ok   ${what}`); else { fails++; console.log(`FAIL: ${what}`); } };
const ev = (state, e, hp = 2, maxHp = 2) => apply(state, e, hp, maxHp);

// 1. State shape and the character baseline
console.log('\n-- 1. state and baseline');
const std = profileOf(traitsOf('standard'));
const m0 = moraleOf(std);
check(m0.value === 55 && m0.baseline === 55 && m0.hurt === 1 && m0.regen === 0.25, 'a standard monster starts at its baseline 55 with no sensitivity shift');
check(moraleOf(profileOf(traitsOf('aggressive'))).value === 70, 'an aggressive monster starts at 70');
check(moraleOf(profileOf(traitsOf('timid'))).value === 40 && moraleOf(profileOf(traitsOf('timid'))).regen === 0.15, 'a timid monster starts at 40 and recovers slowest');
check(moraleOf(profileOf(traitsOf('patient_hunter'))).moralePack === undefined && profileOf(traitsOf('patient_hunter')).moralePack === 1, 'a pack hunter values its packmates fully (profile, not state)');
check(JSON.parse(JSON.stringify(m0)).value === 55, 'the state is plain JSON');

// 2. Every event moves M the documented way
console.log('\n-- 2. events');
check(ev(m0, 'clawed').value === 55 + D_CLAWED, 'clawed raises morale');
check(ev(m0, 'wounded', 1, 2).value === 55 + D_WOUNDED, 'a wound that takes half the health costs the full amount');
check(ev(moraleOf(std), { type: 'wounded', damage: 1 }, 3, 4).value === 55 + D_WOUNDED / 2, 'a wound that takes a quarter of the health costs half as much');
check(ev(m0, 'blocked').value === 50 && ev(m0, 'shrugged').value === 53, 'a blocked and a shrugged-off claw each cost their own amount');
check(ev(m0, 'packmate_lost').value === 40, 'a packmate dispelled within earshot is the heaviest blow');
check(ev(m0, 'gave_up').value === 49, 'giving up costs morale');
check(ev(ev(m0, 'blocked'), 'help_came').value === 54, 'help raises it again');
let threw = false;
try { ev(m0, 'nonsense'); } catch { threw = true; }
check(threw, 'an unknown event throws');
check(EVENT_IDS.length === 10, 'ten events in the vocabulary');

// 3. The character's sensitivity scales the negatives only
console.log('\n-- 3. sensitivity (the caution trait)');
const touchy = createMorale({ start: 55, hurt: 1.6 });
const thick = createMorale({ start: 55, hurt: 0.6 });
check(ev(touchy, 'blocked').value === 47 && ev(thick, 'blocked').value === 52, 'a careful monster loses more from a setback than a reckless one');
check(ev(touchy, 'clawed').value === ev(thick, 'clawed').value, 'sensitivity never scales a gain');

// 4. Ceilings and the per-hunt slip budget
console.log('\n-- 4. ceilings and caps');
const high = createMorale({ start: 90 });
check(ev(high, 'help_came').value === 90 && ev(high, 'cornered').value === 90, 'help and a cornered explorer never pull a higher morale down');
check(ev(createMorale({ start: 60 }), 'help_came').value === 64, 'help still works below the ceiling');
let s = createMorale({ start: 55 });
for (let i = 0; i < 10; i++) s = ev(s, 'slipped');
check(55 - s.value === SLIPPED_MAX, `losing sight again and again costs at most ${SLIPPED_MAX} per hunt`);
const fresh = startHunt(s);
check(fresh.hunt.slipped === 0 && fresh.value === s.value, 'a new hunt resets the slip budget but never the score');

// 5. The hp cap
console.log('\n-- 5. hp cap');
check(cap(2, 2) === 100 && cap(1, 1) === 100, 'full health (or a single hit point in all) caps at 100');
check(cap(1, 2) === LAST_HP_CAP && cap(1, 4) === LAST_HP_CAP, 'the last hit point caps at 40');
check(cap(2, 4) === 65 && cap(3, 4) === 83, 'a part-wounded troll caps in between');
check(combine(90, 95, 1, 2, 55) === LAST_HP_CAP, 'however high the history, the hit points cap what the monster feels');

// 6. Regen waits, then pulls toward the baseline from either side
console.log('\n-- 6. regen');
let r = createMorale({ start: 55 });
r = ev(r, 'blocked'); // 50, idle 0
for (let i = 0; i < 10; i++) r = ev(r, 'regen');
check(r.value === 50, 'regen does nothing for the first ten quiet ticks');
r = ev(r, 'regen');
check(r.value === 50.25, 'then it moves a quarter point toward the baseline');
let down = createMorale({ start: 55 });
down = ev(down, 'clawed'); // 63
for (let i = 0; i < 12; i++) down = ev(down, 'regen');
check(down.value < 63 && down.value > 55, 'it comes back down from above the baseline too');
let slow = createMorale({ start: 40, regen: 0.15 });
slow = ev(slow, 'blocked');
for (let i = 0; i < 11; i++) slow = ev(slow, 'regen');
check(Math.abs(slow.value - 35.15) < 1e-9, 'a monster that gives up fast also recovers slowly');
const held = ev(ev(r, 'regen'), 'blocked');
check(held.idle === 0, 'an event that moves morale restarts the wait');

// 7. Capability
console.log('\n-- 7. capability');
check(capability({ hp: 2, maxHp: 2, strikesToDispel: 2, armed: false }) === 67, 'a healthy ghost that sees no sword is capable');
check(capability({ hp: 2, maxHp: 2, strikesToDispel: 2, armed: true }) === 50, 'an armed explorer in sight halves the exposure term');
check(capability({ hp: 1, maxHp: 2, strikesToDispel: 1, armed: true }) === 25, 'one strike from death against an armed explorer is the weakest spot');
check(capability({ hp: 4, maxHp: 4, strikesToDispel: 4, armed: true }) === 61, 'a troll stays capable with the sword out');
check(capability({ hp: 4, maxHp: 4 }) === CAPABILITY_MAX, 'capability alone never exceeds its ceiling');
check(capability({ hp: 2, maxHp: 2, strikesToDispel: 2, armed: true, support: 2, packWeight: 1 }) === 66, 'packmates in earshot add capability');
check(capability({ hp: 2, maxHp: 2, strikesToDispel: 2, armed: true, support: 2, packWeight: 0 }) === 50, 'a loner gains nothing from them');
check(capability({ hp: 2, maxHp: 2, strikesToDispel: 2, armed: true, support: 9, packWeight: 1 }) === capability({ hp: 2, maxHp: 2, strikesToDispel: 2, armed: true, support: 3, packWeight: 1 }), 'only the nearest few packmates count');
check(capability({ hp: 2, maxHp: 2, armed: false, stunned: true }) <= 20, 'a stunned monster is at its weakest');

// 8. combine, bands
console.log('\n-- 8. combine and bands');
check(combine(50, 55, 2, 2, 55) === 50, 'a neutral history leaves capability alone');
check(combine(50, 70, 2, 2, 55) === 65 && combine(50, 40, 2, 2, 55) === 35, 'history shifts it both ways');
check(combine(50, 200, 2, 2, 55) === 80 && combine(50, 0, 2, 2, 55) === 20, 'the shift is bounded by the span');
check(combine(50, 70, 1, 2, 55) === LAST_HP_CAP, 'the hp cap still wins');
check(band(85) === 'savage' && band(70) === 'eager' && band(50) === 'steady' && band(35) === 'wavering' && band(10) === 'broken', 'band words');
check(BANDS.every(([lo], i, a) => i === 0 || lo < a[i - 1][0]), 'the bands fall');

// 9. Tiers, hysteresis and rout
console.log('\n-- 9. tiers and rout');
check(tier(10) === 'low' && tier(50) === 'mid' && tier(80) === 'high', 'the three tiers');
function tier(M, prev = null) { return (M <= TIER_LOW_MAX || (prev === 'low' && M <= TIER_LOW_MAX + TIER_HYST)) ? 'low' : (M >= TIER_HIGH_MIN || (prev === 'high' && M >= TIER_HIGH_MIN - TIER_HYST)) ? 'high' : 'mid'; }
check(MOODS[moodFor(TIER_LOW_MAX + 3, 'cagey')].tier === 'low', 'a low-tier monster keeps the low tier a few points past the edge');
check(MOODS[moodFor(TIER_LOW_MAX + 3, 'stalking')].tier === 'mid', 'and a mid-tier one does not fall into it at the same morale');
check(routNext(10) === true && routNext(15) === false, `rout starts below ${ROUT_ENTER}`);
check(routNext(15, true) === true && routNext(ROUT_EXIT, true) === false, `and ends only at ${ROUT_EXIT}`);
check(ROUT_ENTER < 20 && ROUT_EXIT <= 20, 'a monster breaks later than the explorer panics (less survival instinct)');

// 10. Moods
console.log('\n-- 10. moods');
check(MOOD_IDS.length === 7 && MOOD_IDS.includes('rout'), 'six moods plus rout');
check(Object.values(TIER_MOODS).flat().length === 6 && !Object.values(TIER_MOODS).flat().includes('rout'), 'rout is never one of a tier\'s moods');
check(Object.values(TIER_MOODS).every((l) => l.length === 2), 'two moods per tier');
check(moodFor(5) === 'skittish' && moodFor(30) === 'cagey' && moodFor(40) === 'stalking' && moodFor(65) === 'pressing' && moodFor(75) === 'relentless' && moodFor(95) === 'frenzied', 'morale picks the mood inside its tier');
check(MOODS[DEFAULT_MOOD].line === '' && MOODS[DEFAULT_MOOD].keepDistance === 0 && MOODS[DEFAULT_MOOD].keepHunting === 0 && MOODS[DEFAULT_MOOD].searchFactor === 1, 'stalking is the identity row: it changes nothing and sends no line');
check(Object.values(MOODS).every((m) => m.line.length <= 110), 'every mood line fits the byte budget');
check(Object.values(MOODS).every((m) => !/ghost|troll/i.test(m.line + m.note)), 'no mood text names a monster kind');
const k = moodKnobs('skittish', std);
check(k.keepDistance === 2 && k.strikeLevel === 1 && k.keepHuntingMin === 0.7 && k.maxSearchTicks === 11 && k.calls === true && k.prefer === 'cut_off', 'skittish keeps its distance, strikes rarely, gives up sooner and calls for help');
const kh = moodKnobs('frenzied', std);
check(kh.keepDistance === 0 && kh.strikeLevel === 3 && kh.keepHuntingMin === 0.1 && kh.maxSearchTicks === 32, 'frenzied does the opposite');
const ks = moodKnobs('stalking', std);
check(ks.keepHuntingMin === std.keepHuntingMin && ks.maxSearchTicks === std.maxSearchTicks && ks.keepDistance === 0 && ks.prefer === std.preferredSearch, 'stalking reproduces the character exactly');
check(moodKnobs('skittish', profileOf(traitsOf('timid'))).calls === true, 'even a loner calls for help when it is shaken');
check(moodKnobs('cagey', { keepDistance: 2 }).keepDistance === 2, 'a careful character keeps its own larger distance');

// 11. Purity and determinism
console.log('\n-- 11. purity');
const before = JSON.stringify(m0);
ev(m0, 'wounded'); ev(m0, 'clawed'); moodFor(50, 'stalking'); moodKnobs('cagey', std);
check(JSON.stringify(m0) === before, 'nothing mutates its input');
const run = () => { let x = moraleOf(std); for (const e of ['clawed', 'slipped', 'wounded', 'regen', 'blocked', 'help_came', 'regen']) x = ev(x, e); return JSON.stringify(x); };
check(run() === run(), 'the same events give the same state');
const src = await (await import('node:fs/promises')).readFile(new URL('../src/characters/adversary/morale.js', import.meta.url), 'utf8');
check(!/^import /m.test(src), 'morale.js imports nothing');
check(!/Math\.random|Date\.now|performance\.now/.test(src), 'and uses no clock or randomness');

// 12. The config hook round-trips
console.log('\n-- 12. config hook');
const snap = moraleSnapshot();
configureMorale({ morClawed: 3, morRoutEnter: 5, morTierLowMax: 30, morBandSavage: 85 });
check(moraleSnapshot().morClawed === 3 && moraleSnapshot().morRoutEnter === 5 && band(84) !== 'savage', 'configureMorale changes the live values');
configureMorale(snap);
check(JSON.stringify(moraleSnapshot()) === JSON.stringify(snap), 'and puts them all back');

console.log(fails ? `\n${fails} FAILED` : '\nall morale checks passed');
process.exit(fails ? 1 : 0);
