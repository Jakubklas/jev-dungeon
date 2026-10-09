// Monster kinds (ghost, troll): registry, spawn assignment on its own stream, the Adversary accessor, testbed
// `kinds`, the view. Free, no Jev.
import { generateDungeon } from '../src/dungeon.js';
import { Adversary, configureAdversaries, spawnAdversaries } from '../src/characters/adversary/adversary.js';
import { KIND_IDS, LEVEL_RANGE, LEVELS, assignKinds, assignLevels, defaultLevel, levelsFor, levelStats, kindOf } from '../src/characters/adversary/kinds.js';
import { TestbedError, buildArena } from '../src/testbed.js';
import { newTestGame } from '../src/turn.js';
import { stepAdversaries } from '../src/characters/adversary/adversary.js';
const stepAdversariesOnce = (game) => { return stepAdversaries(game, { decide: () => ({}) }); };

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log(`FAIL: ${msg}`); } };
globalThis.fetch = () => { throw new Error('fetch tripwire: kinds checks must not call Jev'); };

check(KIND_IDS.join() === 'ghost,troll,tree_giant,wolf', 'four supported monster kinds');
check(kindOf('troll').name === 'Troll', 'kindOf troll');
let threw = false; try { kindOf('toString'); } catch { threw = true; }
check(threw, 'kindOf rejects an unknown id (also an Object.prototype name)');

// Adversary: default ghost, six public keys unchanged, troll gets the ghost's numbers.
const g = new Adversary({ id: 'a1', pos: [1, 1] });
const t = new Adversary({ id: 'a2', pos: [2, 1], kind: 'troll' });
check(g.kind === 'ghost' && t.kind === 'troll', 'kind accessor');
check(Object.keys(t).join() === 'id,pos,mode,budget,lastSeen,goal' && !JSON.stringify(t).includes('troll'), 'kind is not a public field');
const claw = (a) => a.skills.skills.find((k) => k.kind === 'attack');
check(g.hp === 2 && t.hp === 4 && t.maxHp === 4, 'ghost has 2 hp, troll 4');
check(claw(g).damage === 1 && claw(t).damage === 2 && claw(t).cooldown === claw(g).cooldown, 'troll claw takes 2 lives, ghost 1');
check(g.speed === 1 && t.speed < 1 && t.speed > 0, 'troll is slower than a ghost');
check(claw(new Adversary({ id: 'a4', pos: [1, 1], kind: 'troll', skills: 'ghost' })).damage === 1, 'explicit skills are taken as given');
check(new Adversary({ id: 'a3', pos: [1, 1], kind: 'troll', hp: 4 }).hp === 4, 'explicit hp overrides the kind');
threw = false; try { new Adversary({ id: 'a4', pos: [1, 1], kind: 'dragon' }); } catch { threw = true; }
check(threw, 'unknown kind throws');

// Spawn: kinds never move a ghost or change a dungeon; share 0 = all ghosts, 1 = all trolls.
for (let seed = 1; seed <= 30; seed++) {
  const d = generateDungeon(seed);
  configureAdversaries({ trollShare: 0 });
  const none = spawnAdversaries(d);
  configureAdversaries({ trollShare: 1 });
  const all = spawnAdversaries(d);
  configureAdversaries({ trollShare: 0.5 });
  const half = spawnAdversaries(d);
  const cells = (l) => JSON.stringify(l.map((a) => a.pos));
  check(cells(none) === cells(all) && cells(none) === cells(half), `seed ${seed}: positions independent of trollShare`);
  check(none.every((a) => ['ghost', 'wolf'].includes(a.kind)) && all.every((a) => ['troll', 'tree_giant'].includes(a.kind)), `seed ${seed}: share 0 / 1`);
  check(half.map((a) => a.kind).join() === assignKinds(seed, half.length, 0.5).join(), `seed ${seed}: spawn uses assignKinds`);
}
configureAdversaries({ trollShare: 0.25 });
const prefix = assignKinds(7, 3, 0.5), longer = assignKinds(7, 9, 0.5);
check(prefix.join() === longer.slice(0, 3).join(), 'a monster\'s kind does not depend on the monster count');

// Spawn ratios over a large deterministic sample, plus dedicated stats and personalities.
const counts = Object.fromEntries(KIND_IDS.map((kind) => [kind, 0]));
for (const kind of assignKinds(47, 100000, 0.4)) counts[kind]++;
check(Math.abs(counts.wolf / counts.ghost - 1) < 0.03, 'wolf spawn rate matches ghost');
check(Math.abs(counts.tree_giant / counts.troll - 0.5) < 0.02, 'tree giant spawns half as often as troll');
const giant = new Adversary({ id: 'giant', pos: [1, 1], kind: 'tree_giant', level: 1 });
const wolf = new Adversary({ id: 'wolf', pos: [1, 1], kind: 'wolf', level: 4 });
check(giant.level === 4 && wolf.level === 2, 'kind fixed levels override explicit levels');
check(giant.hp === 8 && giant.clawDamage === 3 && giant.speed === 0.45 && claw(giant).cooldown === 3, 'giant is tough, slow and heavy-hitting');
check(wolf.hp === 3 && wolf.clawDamage === 1 && wolf.speed === 1.2 && claw(wolf).cooldown === 1, 'wolf is quick with frequent lighter bites');
check(giant.profile.homeRadius === 14 && giant.profile.maxSearchTicks === 32 && !giant.profile.makesCalls, 'giant is a persistent territorial loner');
check(wolf.profile.makesCalls && wolf.profile.teamSight && wolf.profile.homeRadius === null, 'wolf hunts widely with its pack');
check(new Adversary({ id: 'custom', pos: [1, 1], kind: 'wolf', character: 'timid' }).character === 'timid', 'explicit personality overrides the kind default');
check(buildArena({ kinds: ['tree_giant', 'wolf'], numAdversaries: 2, levels: 1 }).adversaries.map((a) => `${a.level}:${a.character}`).join() === '4:ancient_guardian,2:pack_stalker', 'testbed gets kind defaults and fixed levels');
check(buildArena({ kinds: 'wolf', characters: 'timid' }).adversaries[0].character === 'timid', 'testbed preserves explicit personality');
const fixedView = newTestGame({ kinds: ['tree_giant', 'wolf'], numAdversaries: 2 }, { ask: () => ({}), decide: () => ({}) }).view().adversaries;
check(fixedView[0].kind === 'tree_giant' && fixedView[0].level === 4 && fixedView[1].kind === 'wolf' && fixedView[1].level === 2, 'run view carries new kinds and fixed levels');

// Testbed.
const kindsOf = (cfg) => buildArena({ numAdversaries: 3, ...cfg }).adversaries.map((a) => a.kind).join();
check(kindsOf({}) === 'ghost,ghost,ghost', 'testbed default is ghosts');
check(kindsOf({ kinds: 'troll' }) === 'troll,troll,troll', 'testbed kinds troll');
check(kindsOf({ kinds: ['troll', 'ghost'] }) === 'troll,ghost,troll', 'testbed kinds list cycles');
check(kindsOf({ kinds: 'troll;ghost' }) === 'troll,ghost,troll', 'testbed kinds URL list');
check(kindsOf({ kinds: 'mixed', seed: 3 }) === kindsOf({ kinds: 'mixed', seed: 3 }), 'testbed mixed is deterministic');
for (const bad of ['dragon', [], ['troll', 'x']]) {
  threw = false; try { buildArena({ kinds: bad }); } catch (e) { threw = e instanceof TestbedError; }
  check(threw, `testbed rejects kinds ${JSON.stringify(bad)}`);
}

// View carries the kind; a troll plays a turn like a ghost.
const run = newTestGame({ numAdversaries: 1, kinds: 'troll', treasure: null }, { ask: () => ({}), decide: () => ({}), memoryDir: '/private/tmp/claude-502/-Users-jakub-jev-playground-dungeon-game/ca19c17d-dfc6-41fe-b0d0-86bd2a9b4157/scratchpad' });
check(run.view().adversaries[0].kind === 'troll', 'view().adversaries[].kind');

// A troll steps less often than a ghost over the same ticks (open arena, patrolling, same seed).
{
  const stepsOf = async (kind) => {
    const r = newTestGame({ size: [20, 9], numAdversaries: 1, kinds: kind, treasure: null, start: [1, 1], seed: 4 }, { ask: () => ({}), decide: () => ({}), memoryDir: '/private/tmp/claude-502/-Users-jakub-jev-playground-dungeon-game/ca19c17d-dfc6-41fe-b0d0-86bd2a9b4157/scratchpad' });
    const a = r.game.adversaries[0];
    let n = 0, last = [...a.pos];
    for (let i = 0; i < 100; i++) {
      await stepAdversariesOnce(r.game);
      if (a.pos[0] !== last[0] || a.pos[1] !== last[1]) n++;
      last = [...a.pos];
    }
    return n;
  };
  const gs = await stepsOf("ghost"), ts = await stepsOf("troll");
  check(ts < gs && ts > 0, `troll moved ${ts} times vs ghost ${gs} in 100 ticks`);
}

// Levels (PLAN-levels). The draw over 500 seeds, stats per level, knobs and the Adversary are in check-config section 9;
// the explorer side is check-levels. Here: the exports, the stream's independence, the spawn wiring and the view.
{
  check(Object.isFrozen(LEVEL_RANGE) && LEVEL_RANGE.ghost.join() === '1,2' && LEVEL_RANGE.troll.join() === '2,3' && LEVELS.join() === '1,2,3,4', 'LEVEL_RANGE ghost 1-2, troll 2-3');
  check(defaultLevel('ghost') === 2 && defaultLevel('troll') === 2, 'defaultLevel is 2 for both kinds');
  const ks = ['ghost', 'troll', 'ghost', 'troll', 'troll'];
  check(assignLevels(9, ks.slice(0, 3)).join() === assignLevels(9, ks).slice(0, 3).join(), 'a monster\'s level does not depend on the monster count');
  check(assignLevels(9, ks).join() === levelsFor('random', 9, ks).join() && levelsFor(3, 1, ks).every((l) => l === 3) && levelsFor([1, 3], 1, ks).join() === '1,3,1,3,1', 'levelsFor: random / number / cycled list');
  for (const kind of KIND_IDS) for (const lv of LEVELS) {
    const st = levelStats(kind, lv);
    check(st.hp >= 1 && st.clawDamage >= 1 && Number.isInteger(st.hp) && Number.isInteger(st.clawDamage), `levelStats ${kind} L${lv} is whole and at least 1`);
  }
  check(levelStats('troll', 3).hp > levelStats('troll', 2).hp && levelStats('ghost', 2).hp > levelStats('ghost', 1).hp, 'levelStats: hp rises with level');
  for (const bad of [0, 5, 1.5, '2']) { threw = false; try { levelStats('ghost', bad); } catch { threw = true; } check(threw, `levelStats rejects level ${JSON.stringify(bad)}`); }
  for (let seed = 1; seed <= 30; seed++) {
    const d = generateDungeon(seed);
    configureAdversaries({ trollShare: 0.5 });
    const sp = spawnAdversaries(d);
    check(sp.map((a) => a.level).join() === assignLevels(seed, sp.map((a) => a.kind)).join() && sp.every((a) => LEVEL_RANGE[a.kind].includes(a.level)), `seed ${seed}: spawn uses assignLevels, in range`);
  }
  const lr = newTestGame({ numAdversaries: 1, kinds: 'troll', levels: 3, treasure: null }, { ask: () => ({}), decide: () => ({}), memoryDir: '/private/tmp/claude-502/-Users-jakub-jev-playground-dungeon-game/ca19c17d-dfc6-41fe-b0d0-86bd2a9b4157/scratchpad' });
  const av = lr.view().adversaries[0];
  check(av.level === 3 && av.claw_damage === lr.game.adversaries[0].clawDamage && lr.view().explorer.remark === null, 'view: level, claw_damage and explorer.remark');
  check(Object.keys(lr.game.adversaries[0]).join() === 'id,pos,mode,budget,lastSeen,goal', 'level is not a public field');
}

if (fails) { console.log(`${fails} failure(s)`); process.exit(1); }
console.log('check-kinds: all checks passed');
