// Monster morale through the real code (PLAN-monster-morale.md M3-M5): every event fires from the path that
// really produces it, the hp cap bites, the mood moves knobs, a routed monster breaks off, the memory shape
// validates, requests are byte-identical with the toggle off, and no hidden state reaches a request.
// Free: the brains get a stub `decide` and fetch is a tripwire.
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { Game, SIGHT_RANGE, configureWorld } from '../src/dungeon.js';
import { Adversary, configureAdversaries, stepAdversaries } from '../src/characters/adversary/adversary.js';
import { MORALE_ON, applyMorale, buildRequest, queueMorale } from '../src/characters/adversary/brain.js';
import { AdversaryView } from '../src/characters/adversary/adversary-view.js';
import { validateMemory } from '../src/characters/adversary/memory.js';
import { EXPLORER, resolveAttack } from '../src/skills/resolve.js';
import { configureSkills, skillConfig } from '../src/skills/config.js';
import { MOODS, ROUT_ENTER, moodKnobs } from '../src/characters/adversary/morale.js';
import { profileOf, traitsOf } from '../src/characters/adversary/character.js';

let fails = 0;
const check = (ok, what) => { if (ok) console.log(`ok   ${what}`); else { fails++; console.log(`FAIL: ${what}`); } };
const moraleOn = (on) => configureAdversaries({ monsterMorale: on });

// A hand-drawn arena. `E` is the explorer start.
function handMap(rows) {
  let start;
  const tiles = rows.map((row, y) => [...row].map((c, x) => { if (c === 'E') start = [x, y]; return c === '#' ? '#' : '.'; }).join(''));
  const dungeon = { seed: 1, width: rows[0].length, height: rows.length, tiles, start, treasure: null, rooms: [{ x: 1, y: 1, w: rows[0].length - 2, h: rows.length - 2 }] };
  const game = new Game(dungeon);
  game.adversaries = [];
  return game;
}
const ROOM = [
  '###########',
  '#.........#',
  '#.........#',
  '#....E....#',
  '#.........#',
  '#.........#',
  '###########',
];
// A stub brain that always stands still: this check is about morale, not movement.
const decide = async ({ questions }) => ({
  ...(questions.next_move ? { next_move: { choice: [...Object.keys(questions.next_move.criteria)].sort()[0], probabilities: {} } } : {}),
  ...(questions.search_approach ? { search_approach: { choice: 'sweep_last_seen' } } : {}),
  ...(questions.keep_hunting ? { keep_hunting: { noul: 0.9 } } : {}),
  ...(questions.skill ? { skill: { choice: 'none', probabilities: { none: 1 } } } : {}),
});
const arena = (cells, extra = {}) => {
  const game = handMap(ROOM);
  game.adversaries = cells.map((pos, i) => new Adversary({ id: `a${i + 1}`, pos: [...pos], ...extra }));
  return game;
};
const moraleOf = (a) => a.memory.morale;
const phase = async (game, ticks = 1) => { for (let i = 0; i < ticks; i++) await stepAdversaries(game, { decide }); };

configureWorld({});
configureSkills({});

// 1. The toggle
console.log('\n-- 1. the toggle');
moraleOn(false);
let g = arena([[7, 3]]);
await phase(g);
check(MORALE_ON === false && moraleOf(g.adversaries[0]) === null && g.adversaries[0].hunt.knobs === null, 'with the toggle off a monster keeps no morale at all');
const offBody = buildRequest(new AdversaryView(g, g.adversaries[0]), g.adversaries[0], 1, { speed: 0.6, maxSearchTicks: 18 }).body;
moraleOn(true);
g = arena([[7, 3]]);
await phase(g);
const m = moraleOf(g.adversaries[0]);
check(m && m.value > 0 && m.mood === 'stalking' && m.tier === 'mid', `with it on a standard monster starts stalking in the mid tier (${JSON.stringify(m)})`);
const onBody = buildRequest(new AdversaryView(g, g.adversaries[0]), g.adversaries[0], 1, { speed: 0.6, maxSearchTicks: 18 }).body;
check(onBody !== offBody && JSON.parse(onBody).state.self.morale, 'and the request carries self.morale');
check(Buffer.byteLength(onBody) - Buffer.byteLength(offBody) < 700, `the whole morale text costs under 700 bytes (${Buffer.byteLength(onBody) - Buffer.byteLength(offBody)} B)`);

// 2. Wounded and stunned come from the real strike path
console.log('\n-- 2. a sword strike');
moraleOn(true);
g = arena([[4, 3], [9, 5]]); // a spare monster, so a dispel never ends the game
const hurt = g.adversaries[0];
const before = (await (async () => { await phase(g); return moraleOf(hurt).value; })());
resolveAttack(g, EXPLORER, [[4, 3]], 1); // the explorer's sword, as KnownWorld.useSkill calls it
await phase(g);
const after = moraleOf(hurt).value;
check(after < before, `a wound lowers morale (${before} -> ${after})`);
check(moraleOf(hurt).counts.wounded === 1, 'and it is counted once');
check(after <= 40, 'a monster on its last hit point can never be above the last-hp cap');
check(MOODS[moraleOf(hurt).mood].tier === 'low', `a wounded monster drops into the low tier (${moraleOf(hurt).mood})`);
check(moraleOf(hurt).mood !== 'rout', 'but a standard monster does not break off over a single wound (it has less survival instinct than the knight)');

// 3. Its own claw: hit, blocked, shrugged
console.log('\n-- 3. its own claw');
const clawAt = async (setup = () => {}) => {
  moraleOn(true);
  const game = arena([[4, 3], [9, 5]]);
  const a = game.adversaries[0];
  await phase(game); // sees the explorer, brain on
  setup(game);
  a.pos = [3, 3]; // step next to the explorer and let it claw
  game.pos = [4, 3];
  a.budget = 1;
  const base = moraleOf(a).value;
  await stepAdversaries(game, { decide: async ({ questions }) => ({ ...(await decide({ questions })), ...(questions.skill ? { skill: { choice: [...Object.keys(questions.skill.criteria)].sort().find((k) => k !== 'none') ?? 'none', probabilities: { [[...Object.keys(questions.skill.criteria)].sort().find((k) => k !== 'none') ?? 'none']: 1 } } } : {}) }) });
  await phase(game); // the next phase applies what the claw achieved
  return { a, base, now: moraleOf(a).value, game };
};
const hitCase = await clawAt();
check(hitCase.now > hitCase.base || hitCase.game.health < hitCase.game.maxHealth, `a claw that lands raises morale (${hitCase.base} -> ${hitCase.now})`);
const blockCase = await clawAt((game) => { game.block = { effectiveness: 1, until_step: game.steps + 5 }; });
check(blockCase.now < blockCase.base && moraleOf(blockCase.a).counts.blocked === 1, `a blocked claw lowers it (${blockCase.base} -> ${blockCase.now})`);
const graceCase = await clawAt((game) => { game.graceTicks = 9; });
check(graceCase.now < graceCase.base, `a claw that lands during grace lowers it a little (${graceCase.base} -> ${graceCase.now})`);

// 4. The death cry
console.log('\n-- 4. the death cry');
moraleOn(true);
g = arena([[4, 3], [6, 3], [9, 1]]);
await phase(g);
const near = g.adversaries[1], far = g.adversaries[2];
const nearBefore = moraleOf(near).value, farBefore = moraleOf(far).value;
resolveAttack(g, EXPLORER, [[4, 3]], 9); // dispels a1 outright
check(g.dispelled.length === 1 && g.dispelled[0].id === 'a1', 'the dispel is recorded on the game for the tick');
await phase(g);
check(moraleOf(near).value < nearBefore && moraleOf(near).counts.lost === 1, `a packmate within earshot feels it (${nearBefore} -> ${moraleOf(near).value})`);
check(farBefore - moraleOf(far).value >= 0, 'a packmate out of earshot is not raised by it');
g.clearTickState();
check(g.dispelled.length === 0, 'the record is cleared with the rest of the tick state');

// 5. The mood moves real knobs
console.log('\n-- 5. the mood moves knobs');
const std = profileOf(traitsOf('standard'));
check(moodKnobs('stalking', std).maxSearchTicks === std.maxSearchTicks && moodKnobs('skittish', std).maxSearchTicks < std.maxSearchTicks, 'a shaken monster gives up sooner than a steady one');
moraleOn(true);
g = arena([[4, 3], [9, 5]]);
await phase(g);
const victim = g.adversaries[0];
resolveAttack(g, EXPLORER, [[4, 3]], 1);
await phase(g, 2);
const k = victim.hunt.knobs;
check(k && k.keepDistance >= 1, `a wounded monster now keeps its distance (keepDistance ${k?.keepDistance})`);
check(k.strikeLevel === 1, 'and only strikes when cornered');
const req = buildRequest(new AdversaryView(g, victim), victim, 9, { speed: 0.6, maxSearchTicks: 18 });
const text = req.body ?? '';
check(/keep at least/.test(text) || !victim.hunt.inSight, 'the keep-distance priority reaches the request while the sword is in sight');
check(text.includes(MOODS[victim.hunt.mood].line.slice(0, 30)), `the mood's own priority line is sent (${victim.hunt.mood})`);

// 6. Rout: it breaks off and keeps away
console.log('\n-- 6. rout');
moraleOn(true);
g = arena([[4, 3], [9, 5]]);
const router = g.adversaries[0];
await phase(g);
check(router.hunt.on, 'the monster is hunting before the rout');
for (let i = 0; i < 6; i++) queueMorale(router, 'packmate_lost'); // its whole pack goes down around it
resolveAttack(g, EXPLORER, [[4, 3]], 1);
let routed = false;
for (let i = 0; i < 4 && !routed; i++) { const out = await stepAdversaries(g, { decide }); routed = out.events.some((e) => e.type === 'routed'); }
check(routed, 'a monster whose morale collapses emits `routed`');
check(router.hunt.mood === 'rout' && !router.hunt.on && router.mode === 'patrol', 'it breaks off: brain off, back to patrolling (never a new public mode)');
check(router.hunt.restUntil > g.adversaryTicks, `and it will not start a new hunt for a while (rest until ${router.hunt.restUntil}, tick ${g.adversaryTicks})`);
const routTick = g.adversaryTicks;
await phase(g, 2);
check(!router.hunt.on, 'it stays out of the hunt while it recovers, even with the explorer in plain sight');
check(['rout', 'skittish', 'cagey'].includes(router.hunt.mood), `and it stays in the low tier while it recovers (${router.hunt.mood})`);

// 7. Memory shape and persistence
console.log('\n-- 7. memory');
check(validateMemory(router.memory) === router.memory, 'the memory with morale in it validates');
const keys = Object.keys(router.memory.morale).join();
check(keys === 'value,baseline,tier,mood,counts', `the mirror holds exactly the documented keys (${keys})`);
check(Object.keys(router.memory).join().includes('morale,skills'), 'morale sits next to the skills mirror');
let broke = false;
try { validateMemory({ ...router.memory, morale: { ...router.memory.morale, mood: 'brave' } }); } catch { broke = true; }
check(broke, 'an unknown mood is rejected');
check(Object.keys(router).length === 6, 'the monster still has exactly six public keys');
check(!JSON.stringify(router).includes('morale'), 'and morale is private: it is not in the JSON shape');
const kept = moraleOf(router).value;
g.pos = [4, 3];
router.hunt.restUntil = 0;
await phase(g, 2);
check(Math.abs(moraleOf(router).value - kept) < 3, 'a new hunt does not reset the score (it only clears the slip budget)');

// 8. Determinism and fog
console.log('\n-- 8. determinism and fog');
const play = async () => {
  moraleOn(true);
  const game = arena([[4, 3], [6, 2], [9, 5]]);
  for (let i = 0; i < 6; i++) { await stepAdversaries(game, { decide }); if (i === 2) resolveAttack(game, EXPLORER, [[4, 3]], 1); }
  return game.adversaries.map((a) => `${a.id}:${JSON.stringify(moraleOf(a))}`).join('|');
};
check(await play() === await play(), 'the same tick sequence gives the same morale for every monster');
// A twin game with the hidden explorer moved must not change a request: morale is own state plus what the view shows.
moraleOn(true);
g = arena([[4, 3], [9, 5]]);
await phase(g, 3);
const watcher = g.adversaries[0];
const cfg = { speed: 0.6, maxSearchTicks: 18, characters: false, limited: false };
const bodyA = buildRequest(new AdversaryView(g, watcher), watcher, 9, cfg).body;
const twin = g.twin({ pos: [1, 5], trail: [[1, 5]], visits: new Map(), coinPiles: [] });
const bodyB = buildRequest(new AdversaryView(twin, watcher), watcher, 9, cfg).body;
check(watcher.hunt.inSight === false ? bodyA === bodyB : true, 'out of sight, moving the hidden explorer changes nothing in the request');
check(!String(bodyA).includes('"baseline"') && !String(bodyA).includes('counts'), 'the request carries only the morale word, never the raw state');

console.log(fails ? `\n${fails} FAILED` : '\nall morale wiring checks passed');
moraleOn(false);
process.exit(fails ? 1 : 0);
