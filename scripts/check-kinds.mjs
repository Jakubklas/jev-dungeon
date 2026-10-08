// Monster kinds (ghost, troll): registry, spawn assignment on its own stream, the Adversary accessor, testbed
// `kinds`, the view. Free, no Jev.
import { generateDungeon } from '../src/dungeon.js';
import { Adversary, configureAdversaries, spawnAdversaries } from '../src/characters/adversary/adversary.js';
import { KIND_IDS, assignKinds, kindOf } from '../src/characters/adversary/kinds.js';
import { TestbedError, buildArena } from '../src/testbed.js';
import { newTestGame } from '../src/turn.js';

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log(`FAIL: ${msg}`); } };
globalThis.fetch = () => { throw new Error('fetch tripwire: kinds checks must not call Jev'); };

check(KIND_IDS.join() === 'ghost,troll', 'kinds are ghost and troll');
check(kindOf('troll').name === 'Troll', 'kindOf troll');
let threw = false; try { kindOf('toString'); } catch { threw = true; }
check(threw, 'kindOf rejects an unknown id (also an Object.prototype name)');

// Adversary: default ghost, six public keys unchanged, troll gets the ghost's numbers.
const g = new Adversary({ id: 'a1', pos: [1, 1] });
const t = new Adversary({ id: 'a2', pos: [2, 1], kind: 'troll' });
check(g.kind === 'ghost' && t.kind === 'troll', 'kind accessor');
check(Object.keys(t).join() === 'id,pos,mode,budget,lastSeen,goal' && !JSON.stringify(t).includes('troll'), 'kind is not a public field');
check(t.hp === g.hp && t.maxHp === g.maxHp && t.skills.skills.length === g.skills.skills.length, 'troll has ghost numbers for now');
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
  check(none.every((a) => a.kind === 'ghost') && all.every((a) => a.kind === 'troll'), `seed ${seed}: share 0 / 1`);
  check(half.map((a) => a.kind).join() === assignKinds(seed, half.length, 0.5).join(), `seed ${seed}: spawn uses assignKinds`);
}
configureAdversaries({ trollShare: 0.25 });
const prefix = assignKinds(7, 3, 0.5), longer = assignKinds(7, 9, 0.5);
check(prefix.join() === longer.slice(0, 3).join(), 'a monster\'s kind does not depend on the monster count');

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

if (fails) { console.log(`${fails} failure(s)`); process.exit(1); }
console.log('check-kinds: all checks passed');
