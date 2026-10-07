// Checks for src/skills/: skill set rules, shape rotation, cooldowns, option gating and fog, the seeded
// block roll, strike resolution on the explorer and on ghosts, and the confidence floor. No Jev, no network.
// Run from the dungeon-game directory: node scripts/check-skills.mjs
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { DIRS, Game } from '../src/dungeon.js';
import { stepAdversaries } from '../src/characters/adversary/adversary.js';
import { buildArena } from '../src/testbed.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { Skill } from '../src/skills/skill.js';
import { AttackSkill } from '../src/skills/attack.js';
import { BlockSkill } from '../src/skills/block.js';
import { MAX_SKILLS, SkillSet } from '../src/skills/skill-set.js';
import { LOADOUTS, buildSkillSet } from '../src/skills/loadouts.js';
import { SKILL_MIN, pickSkill, skillQuestion } from '../src/skills/question.js';
import { EXPLORER, resolveAttack } from '../src/skills/resolve.js';
import { skillConfig, configureSkills } from '../src/skills/config.js';
import { describeMoves } from '../src/characters/explorer/perception.js';
import { ExplorerBrain, SENTIMENTS } from '../src/characters/explorer/brain.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.error('FAIL:', msg); } };
const throws = (fn, label) => { try { fn(); check(false, `${label}: expected a throw`); } catch { /* expected */ } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A game from an ASCII map ('@' explorer, 'A' ghosts), through the testbed.
function arena(map) {
  const { dungeon, adversaries } = buildArena({ map, seed: 7 });
  const game = new Game(dungeon);
  game.adversaries = adversaries;
  return game;
}
const OPEN = ['#######', '#.....#', '#.....#', '#..@..#', '#.....#', '#.....#', '#######'];

// 1. SkillSet: cap and duplicates.
const mkAttack = (id, extra = {}) => new AttackSkill({ id, name: id, source: 'sword', damage: 1, cooldown: 1, ...extra });
check(new SkillSet([1, 2, 3, 4].map((i) => mkAttack(`s${i}`))).size === MAX_SKILLS, 'four skills accepted');
throws(() => new SkillSet([1, 2, 3, 4, 5].map((i) => mkAttack(`s${i}`))), 'five skills');
throws(() => new SkillSet([mkAttack('a'), mkAttack('a')]), 'duplicate ids');
throws(() => new Skill({ id: 'Bad Id', name: 'x', cooldown: 0 }), 'id not snake_case');
throws(() => buildSkillSet(['sword_strike', 'nope']), 'unknown loadout');

// 2. Shape rotation (y points down).
const at = [5, 5];
const one = mkAttack('one');
check(eq(one.cells(at, 'right'), [[6, 5]]), 'facing right: cell to the east');
check(eq(one.cells(at, 'left'), [[4, 5]]), 'facing left: cell to the west');
check(eq(one.cells(at, 'up'), [[5, 4]]), 'facing up: cell to the north');
check(eq(one.cells(at, 'down'), [[5, 6]]), 'facing down: cell to the south');
const sweep = mkAttack('sweep', { shape: [[1, -1], [1, 0], [1, 1]] });
check(eq(sweep.cells(at, 'right'), [[6, 4], [6, 5], [6, 6]]), 'sweep facing right');
check(eq(sweep.cells(at, 'up'), [[4, 4], [5, 4], [6, 4]]), 'sweep facing up (right hand is east)');
check(eq(sweep.cells(at, 'left'), [[4, 6], [4, 5], [4, 4]]), 'sweep facing left (right hand is north)');
check(eq(sweep.cells(at, 'down'), [[6, 6], [5, 6], [4, 6]]), 'sweep facing down (right hand is west)');

// 3. Cooldown and summary.
const sk = mkAttack('cd', { cooldown: 2 });
check(sk.ready, 'new skill is ready');
sk.markUsed(3);
check(!sk.ready && sk.cooldownLeft === 2 && sk.uses === 1 && sk.lastUsedStep === 3, 'used skill is cooling down');
sk.turnPassed();
check(!sk.ready, 'still cooling after one turn');
sk.turnPassed();
check(sk.ready, 'ready after cooldown turns');
sk.turnPassed();
check(sk.cooldownLeft === 0, 'cooldown never goes below 0');
const sum = sk.summary();
check(eq(Object.keys(sum), ['id', 'kind', 'name', 'text', 'ready', 'cooldown_left']), 'summary keys');
check(eq(JSON.parse(JSON.stringify(sum)), sum) && sum.kind === 'attack', 'summary is plain JSON');
check(eq(buildSkillSet('explorer').summaries().map((s) => s.id), ['sword_strike', 'shield_block']), 'explorer loadout');
check(eq(buildSkillSet('ghost').summaries().map((s) => s.id), ['claw_strike']) && LOADOUTS.claw_strike.cooldown === 2, 'ghost loadout has no block');
check(buildSkillSet('none').size === 0, 'none loadout is empty');
check(buildSkillSet('explorer', { shield_block: { effectiveness: 0.9 } }).skills[1].effectiveness === 0.9, 'tuning overrides numbers');

// 4. Options gating, fog-safe facts.
const set = buildSkillSet('explorer');
const view = { pos: [3, 3] };
const quiet = { pos: [3, 3], opponentsNear: false, visibleOpponents: [], threatNear: false };
check(Object.keys(set.options(view, quiet)).length === 0, 'no opponents: no options');
check(skillQuestion(set.options(view, quiet)) === null, 'no options: no question');
check(skillQuestion({}) === null && skillQuestion(null) === null, 'empty map: null question');
const near = { pos: [3, 3], opponentsNear: true, visibleOpponents: [{ id: 'a1', pos: [2, 3], hp: 2, maxHp: 2 }], threatNear: { id: 'a1', steps: 1 }, stunTicks: 2, coinChance: 0.5 };
const opts = set.options(view, near);
check(eq(Object.keys(opts), ['sword_strike_left', 'shield_block']), `options keys ${Object.keys(opts)}`);
check(opts.sword_strike_left.fact.includes('a1 (2 of 2 hp) is knocked back and stunned 2 steps') && opts.sword_strike_left.fact.length <= 160, `strike fact names the ghost, its health bar and the stun: ${opts.sword_strike_left.fact}`);
const last = set.options(view, { ...near, visibleOpponents: [{ id: 'a1', pos: [2, 3], hp: 1, maxHp: 2 }] }).sword_strike_left?.fact ?? '';
check(last.includes('a1 (1 of 2 hp) is dispelled for good (may drop a coin)'), `strike fact on the last hp says it dispels: ${last}`);
const noBar = set.options(view, { ...near, visibleOpponents: [{ id: 'a1', pos: [2, 3] }] }).sword_strike_left?.fact ?? '';
check(noBar.startsWith('Strike the cell to your left: a1 is there now.'), `strike fact without a health bar: ${noBar}`);
check(opts.shield_block.fact.includes('60%') && opts.shield_block.fact.includes('a1 is adjacent'), 'block fact');
check(eq(opts.sword_strike_left.target.dir, 'left') && set.get('sword_strike_left').skill.id === 'sword_strike', 'get(key) returns skill and target');
check(set.get('nope') === null, 'get(unknown) is null');
const nearNoTarget = { ...near, visibleOpponents: [{ id: 'a1', pos: [6, 6] }], threatNear: false };
check(Object.keys(set.options(view, nearNoTarget)).length === 0, 'opponents near but none in a strike cell: nothing offered');
// Hidden state cannot change the output: a scrambled view/self junk gives byte-identical options.
const base = JSON.stringify(set.options(view, near));
const scrambled = JSON.stringify(set.options({ ...view, hidden: { ghosts: [[9, 9]] }, game: { adversaries: [] } },
  { ...near, hiddenGhosts: [{ id: 'a9', pos: [3, 2] }], ghostHp: 1 }));
check(base === scrambled, 'unsupplied hidden data cannot change the options');
const cooling = buildSkillSet('explorer');
cooling.skills[0].markUsed(0);
check(!('sword_strike_left' in cooling.options(view, near)) && 'shield_block' in cooling.options(view, near), 'a cooling skill is not offered');
const q = skillQuestion(opts, 'Strike when adjacent.');
check(q.type === 'choice' && Object.keys(q.criteria)[0] === 'none' && eq(Object.keys(q.criteria), ['none', 'sword_strike_left', 'shield_block']), 'question: none first, then options in order');
check(q.criteria.none === 'Use no skill this step (the usual choice).' && q.instructions.question.endsWith('Strike when adjacent.'), 'question texts');
check(q.instructions.question.includes('at most one skill'), 'question instruction');

// 5. Seeded skill RNG.
{
  const g1 = arena(OPEN), g2 = arena(OPEN);
  const a = Array.from({ length: 20 }, () => g1.skillRandom()), b = Array.from({ length: 20 }, () => g2.skillRandom());
  check(eq(a, b), 'same seed, same skill rolls');
  const g3 = new Game({ ...g1.dungeon, seed: 99 });
  check(!eq(a, Array.from({ length: 20 }, () => g3.skillRandom())), 'another seed rolls differently');
  const g4 = arena(OPEN);
  let low = 0;
  for (let i = 0; i < 10000; i++) if (g4.skillRandom() < 0.6) low++;
  check(Math.abs(low / 10000 - 0.6) <= 0.02, `10000 rolls under 0.6 land at ${low / 10000}`);
  const tw = g1.twin();
  check(typeof tw.skillRandom() === 'number', 'twin keeps skillRandom working');
}

// 6. resolveAttack on the explorer.
const ghostAt = (g, id, pos) => { const a = g.adversaries.find((x) => x.id === id); a.pos = [...pos]; return a; };
{
  const g = arena([...OPEN.slice(0, 2), '#.A...#', ...OPEN.slice(3)]);
  const a1 = g.adversaries[0];
  const cell = [...g.pos];
  const hit = resolveAttack(g, a1, [cell, [0, 0]], 1);
  check(g.health === g.maxHealth - 1 && hit.some((e) => e.type === 'hit' && e.id === 'a1'), 'explorer hit costs a life');
  check(g.strikes.length === 1 && g.strikes[0].result === 'hit' && g.strikes[0].cells.length === 1, 'strike recorded, wall cell dropped');
  check(hit.at(-1).type === 'strike' && hit.at(-1).id === 'a1', 'strike event shape');
  // Block success: rand forced low.
  const g2 = arena(OPEN); g2.adversaries = [new (a1.constructor)({ id: 'a1', pos: [1, 1] })];
  g2.block = { effectiveness: 0.6, until_step: g2.steps + 1 };
  const blocked = resolveAttack(g2, g2.adversaries[0], [g2.pos], 1, { rand: () => 0.1 });
  check(g2.health === g2.maxHealth && blocked.some((e) => e.type === 'blocked') && g2.strikes[0].result === 'blocked', 'block success stops the hit');
  // Block failure: rand high.
  const failed = resolveAttack(g2, g2.adversaries[0], [g2.pos], 1, { rand: () => 0.9 });
  check(g2.health === g2.maxHealth - 1 && failed.some((e) => e.type === 'hit'), 'block failure lets the hit land');
  // Expired stance does nothing.
  const g3 = arena(OPEN); g3.adversaries = [new (a1.constructor)({ id: 'a1', pos: [1, 1] })];
  g3.block = { effectiveness: 1, until_step: g3.steps - 1 };
  g3.steps += 1;
  resolveAttack(g3, g3.adversaries[0], [g3.pos], 1, { rand: () => 0 });
  check(g3.health === g3.maxHealth - 1, 'an expired block stops nothing');
  g3.clearTickState();
  check(g3.block === null && g3.strikes.length === 0, 'clearTickState drops an expired block and the strikes');
  // Protected.
  const g5 = arena(OPEN); g5.adversaries = [new (a1.constructor)({ id: 'a1', pos: [1, 1] })];
  const prot = resolveAttack(g5, g5.adversaries[0], [g5.pos], 1, { canHit: () => false });
  check(g5.health === g5.maxHealth && g5.strikes[0].result === 'protected' && !prot.some((e) => e.type === 'hit'), 'canHit false: protected');
  // Lethal hit emits hit then caught; onHit latch runs.
  const g6 = arena(OPEN); g6.adversaries = [new (a1.constructor)({ id: 'a1', pos: [1, 1] })]; g6.health = 1;
  let latched = 0;
  const lethal = resolveAttack(g6, g6.adversaries[0], [g6.pos], 1, { onHit: () => latched++ });
  check(g6.lost && g6.caughtBy === 'a1' && eq(lethal.map((e) => e.type), ['hit', 'caught', 'strike']) && latched === 1, 'lethal hit: hit, caught, onHit');
}

// 7. Explorer strikes a ghost: knockback, stun, dispel; and KnownWorld.useSkill.
{
  // A spare ghost (a2) far away: dispelling the last one would win the game (section 11) and end the tick state.
  const g = arena(['#######', '#.....#', '#.....#', '#..@A.#', '#.....#', '#....A#', '#######']);
  const ghost = g.adversaries[0];
  const world = new KnownWorld(g);
  const exp = buildSkillSet('explorer');
  const o = exp.options(world, { pos: world.pos, opponentsNear: true, visibleOpponents: [{ id: 'a1', pos: ghost.pos }] });
  check('sword_strike_right' in o, 'sword offered toward the adjacent ghost');
  const ev = world.useSkill(exp, 'sword_strike_right');
  check(g.facing === 'right' && eq(ghost.pos, [5, 3]) && ghost.hp === skillConfig().ghostHp - 1 && ghost.stun === skillConfig().stunTicks, 'ghost knocked back 1 cell, hurt and stunned');
  check(ev.some((e) => e.type === 'struck') && g.strikes[0].result === 'hit', 'struck event and strike recorded');
  check(!exp.skills[0].ready && world.useSkill(exp, 'sword_strike_right') === null, 'sword cooling down: second use refused');
  check(ghost.tickStun() && ghost.tickStun() && !ghost.tickStun(), 'stun lasts stunTicks ticks');
  check(Object.keys(ghost).join() === 'id,pos,mode,budget,lastSeen,goal' && JSON.stringify(ghost).includes('"hp"') === false, 'hp, stun, skills and facing are not own properties');
  // Second hit dispels.
  exp.turnPassed();
  const seen = { pos: world.pos, opponentsNear: true, visibleOpponents: [{ id: 'a1', pos: ghost.pos }] };
  check(!('sword_strike_right' in exp.options(world, seen)), 'knocked-back ghost is out of the front cell');
  ghost.pos = [4, 3];
  exp.options(world, { ...seen, visibleOpponents: [{ id: 'a1', pos: ghost.pos }] });
  const ev2 = world.useSkill(exp, 'sword_strike_right');
  check(ev2?.some((e) => e.type === 'dispelled') && g.adversaries.length === 1 && g.strikes.at(-1).result === 'dispelled' && !g.won, 'second hit dispels and removes the ghost');
  // Block through useSkill.
  g.block = null;
  exp.options(world, { pos: world.pos, opponentsNear: true, visibleOpponents: [], threatNear: true });
  world.useSkill(exp, 'shield_block');
  check(g.block?.effectiveness === 0.6 && g.block.until_step === g.steps + 1, 'shield raises the stance until the next step');
  // Knockback into a wall: ghost stays.
  const g2 = arena(['#####', '#...#', '#@A.#', '#...#', '#####']);
  const w2 = new KnownWorld(g2);
  resolveAttack(g2, EXPLORER, [[2, 2]], 1);
  check(eq(g2.adversaries[0].pos, [3, 2]), 'ghost knocked one cell directly away');
  g2.adversaries[0].pos = [3, 2]; g2.pos = [1, 2];
  resolveAttack(g2, EXPLORER, [[3, 2]], 1);
  check(g2.adversaries.length === 0, 'second hit dispels');
  check(w2.facing === 'right', 'KnownWorld.facing reads the game');
}

// 8. Facing from steps; publicView; twin.
{
  const g = arena(OPEN);
  check(g.facing === 'right', 'facing starts right');
  g.applyMove('up');
  check(g.facing === 'up', 'a step sets facing');
  g.applyMove('stay');
  check(g.facing === 'up', 'STAY keeps facing');
  const v = g.publicView();
  check(v.facing === 'up' && Array.isArray(v.strikes), 'publicView has facing and strikes');
  check(g.twin({ facing: 'left' }).facing === 'left', 'twin works');
}

// 9. pickSkill floor.
{
  const o = { sword_strike_left: { fact: 'x' }, shield_block: { fact: 'y' } };
  check(SKILL_MIN === 0.5, 'SKILL_MIN is 0.5');
  check(pickSkill({ choice: 'sword_strike_left', probabilities: { sword_strike_left: 0.5 } }, o) === 'sword_strike_left', 'at the floor: used');
  check(pickSkill({ choice: 'sword_strike_left', probabilities: { sword_strike_left: 0.49 } }, o) === 'none', 'below the floor: none');
  check(pickSkill({ choice: 'ghost_dance', probabilities: { ghost_dance: 0.9 } }, o) === 'none', 'unknown key: none');
  check(pickSkill({ choice: 'none', probabilities: { none: 0.9 } }, o) === 'none', 'none stays none');
  check(pickSkill({ choice: 'shield_block', probabilities: null }, o) === 'none' && pickSkill(null, o) === 'none', 'no probabilities or answer: none');
}

// 10. Coins: drop on dispel (one roll each), pickup, determinism, twin safety, publicView, fog.
{
  const setChance = (p) => configureSkills({ ...skillConfig(), coinDropChance: p });
  check(skillConfig().coinDropChance === 0.6, 'coinDropChance defaults to 0.6');
  const MAP = ['#######', '#.....#', '#.....#', '#..@A.#', '#.....#', '#....A#', '#######']; // a2 keeps the game going after a1 is dispelled
  const dispel = (g) => { g.adversaries[0].takeHit(skillConfig().ghostHp - 1, [0, 0]); g.adversaries[0].pos = [4, 3]; return resolveAttack(g, EXPLORER, [[4, 3]], 1); };
  try {
    setChance(1);
    const g = arena(MAP);
    const ev = dispel(g);
    check(ev.some((e) => e.type === 'dispelled') && ev.some((e) => e.type === 'coin_drop' && e.id === 'a1' && eq(e.at, [4, 3])), 'chance 1: coin_drop event after dispelled');
    check(ev.findIndex((e) => e.type === 'coin_drop') === ev.findIndex((e) => e.type === 'dispelled') + 1, 'coin_drop follows dispelled');
    check(eq(g.coinPiles, [[4, 3]]) && g.coins === 0, 'chance 1: pile at the death cell');
    const r = g.applyMove('right');
    check(g.coins === 1 && g.coinPiles.length === 0 && r.coins === 1, 'pickup: coins 1, pile gone, return has coins: 1');
    check(g.applyMove('left').coins === 0, 'no pile: coins 0 in the return');

    // Stacked pile: +1 per entry.
    const g3 = arena(MAP);
    g3.coinPiles = [[4, 3], [4, 3], [1, 1]];
    check(g3.applyMove('right').coins === 2 && g3.coins === 2 && eq(g3.coinPiles, [[1, 1]]), 'stacked pile gives one coin per entry');

    setChance(0);
    const g0 = arena(MAP);
    const ref = arena(MAP);
    const ev0 = dispel(g0);
    check(!ev0.some((e) => e.type === 'coin_drop') && g0.coinPiles.length === 0, 'chance 0: no drop');
    ref.coinRandom();
    check(g0.coinRandom() === ref.coinRandom(), 'chance 0: the coin stream still advanced once per dispel');

    // Determinism: same seed, same sequence of dispels, same drops.
    setChance(0.5);
    const run = () => {
      const g = arena(MAP);
      const out = [];
      for (let i = 0; i < 12; i++) {
        g.adversaries = arena(MAP).adversaries;
        out.push(dispel(g).some((e) => e.type === 'coin_drop'));
      }
      return out;
    };
    const d1 = run(), d2 = run();
    check(eq(d1, d2) && d1.some(Boolean) && d1.some((x) => !x), 'same seed, same dispels: same drops (and both outcomes occur at 0.5)');

    // Twin safety.
    const gt = arena(MAP);
    gt.coinPiles = [[4, 3]];
    const tw = gt.twin();
    gt.applyMove('right');
    check(eq(tw.coinPiles, [[4, 3]]) && tw.coins === 0 && gt.coins === 1, 'pickup on the original leaves the twin\'s piles alone');

    // publicView.
    const gv = arena(MAP);
    gv.coinPiles = [[1, 1], [1, 1]];
    gv.coins = 3;
    const v = gv.publicView();
    check(eq(v.coin_piles, [[1, 1], [1, 1]]) && v.coins === 3 && v.coin_piles !== gv.coinPiles && v.coin_piles[0] !== gv.coinPiles[0], 'publicView has coin_piles (copies) and coins');

    // Fog: a pile on a dark cell is not seen, does not change perception or the Jev request; a lit one adds the fact.
    const BIG = ['#' + '#'.repeat(30) + '#', ...Array.from({ length: 5 }, (_, i) => '#' + (i === 2 ? '..@' + '.'.repeat(27) : '.'.repeat(30)) + '#'), '#'.repeat(32)];
    const mk = (piles) => { const g = arena(BIG); g.coinPiles = piles; return g; };
    const far = [28, 3];
    const gA = mk([]), gB = mk([far]);
    check(!gB.isKnown(far), 'fog setup: the far pile is on a dark cell');
    check(eq(new KnownWorld(gB).seenCoins(), []), 'seenCoins hides a pile on an unknown cell');
    const wa = new KnownWorld(gA), wb = new KnownWorld(gB);
    check(eq(describeMoves(wa, 'nearest_frontier', {}), describeMoves(wb, 'nearest_frontier', {})), 'dark pile does not change the move facts');
    const reqOf = async (g) => {
      const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
      const ask = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
        if (q.type === 'noul') return [k, { noul: 0.9 }];
        const c = Object.keys(q.criteria)[0];
        return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
      }));
      const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
      const rnd = Math.random; Math.random = () => 0.5;
      try { await brain.takeTurn(); } finally { Math.random = rnd; }
      const out = brain.lastRequests().map((r) => JSON.stringify(r));
      rmSync(dir, { recursive: true, force: true });
      return out.join('|');
    };
    check((await reqOf(mk([]))) === (await reqOf(mk([far]))), 'dark pile: explorer request byte-identical to the twin without it');
    const lit = mk([[4, 3]]);
    check(eq(new KnownWorld(lit).seenCoins(), [[4, 3]]), 'seenCoins shows a lit pile');
    check(/Picks up a coin\./.test(describeMoves(new KnownWorld(lit), 'nearest_frontier', {}).right ?? ''), 'move onto a known pile says "Picks up a coin."');
    const lit2 = mk([[4, 3], [4, 3]]);
    check(/Picks up 2 coins\./.test(describeMoves(new KnownWorld(lit2), 'nearest_frontier', {}).right ?? ''), 'a two-coin pile says "Picks up 2 coins."');
  } finally {
    setChance(0.6);
  }
  check(skillConfig().coinDropChance === 0.6, 'coinDropChance restored');
}

// 11. Victory by clearing: dispelling the last adversary wins; one of two does not; an arena with none is not won.
{
  const MAP2 = ['#######', '#.....#', '#.....#', '#..@A.#', '#.....#', '#.....#', '#######'];
  const kill = (g, a) => { a.takeHit(skillConfig().ghostHp - 1, [0, 0]); return resolveAttack(g, EXPLORER, [a.pos], 1); };
  const g = arena(MAP2);
  check(!g.won && g.winBy === null && g.publicView().won_by === null, 'a fresh game is not won');
  const ev = kill(g, g.adversaries[0]);
  check(g.won && g.winBy === 'cleared' && !g.lost, 'dispelling the only ghost wins');
  check(ev.some((e) => e.type === 'cleared' && e.id === 'explorer') && g.publicView().won_by === 'cleared' && g.publicView().won === true, 'cleared event and won_by in the view');
  const before = g.pos.join();
  g.applyMove('left');
  check(g.pos.join() === before, 'no moves once won');
  // Two ghosts: the first dispel does not win, the second does.
  const g2 = arena(['#######', '#.....#', '#.....#', '#..@A.#', '#....A#', '#.....#', '#######']);
  check(g2.adversaries.length === 2, 'two-ghost arena has two ghosts');
  kill(g2, g2.adversaries[0]);
  check(!g2.won && g2.adversaries.length === 1, 'one of two dispelled: not won');
  kill(g2, g2.adversaries[0]);
  check(g2.won && g2.winBy === 'cleared', 'the last of two wins');
  // No ghosts at all: never an instant win, and walking onto the chest still says 'chest'.
  const g0 = new Game(buildArena({ map: ['#######', '#.....#', '#.@.T.#', '#.....#', '#.....#', '#######'], numAdversaries: 0, seed: 7 }).dungeon);
  check(!g0.won && g0.adversaries.length === 0, 'an arena with no ghosts is not won');
  g0.applyMove('right'); g0.applyMove('right');
  check(g0.won && g0.winBy === 'chest', 'chest win records winBy chest');
  // A struck-but-alive ghost, and a miss, never win.
  const g3 = arena(MAP2);
  resolveAttack(g3, EXPLORER, [g3.adversaries[0].pos], 1);
  check(!g3.won && g3.adversaries.length === 1, 'a strike that leaves the ghost alive does not win');
}

// 12. Fights have a value (PLAN-motivation P3): the combat rule's live numbers, engage's fact in numbers, the
// "may clear the dungeon" sentence only for the one adversary ever seen, every mood strikes an adjacent one, and
// stubbed duels that back what the texts claim.
{
  const stubAsk = (calls) => async ({ kind, questions, state }) => {
    calls.push({ kind, questions, state });
    return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
      if (q.type === 'noul') return [k, { noul: 0.9 }];
      const keys = Object.keys(q.criteria);
      const c = k === 'sentiment' ? 'aggressive' : k === 'tactic' ? (keys.includes('engage') ? 'engage' : keys[0]) : k === 'skill' ? 'none' : keys[0];
      return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
    }));
  };
  const withBrain = async (g, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const calls = [];
    const brain = new ExplorerBrain(new KnownWorld(g), { ask: stubAsk(calls), memoryDir: pathToFileURL(dir + '/') });
    const rnd = Math.random; Math.random = () => 0.5;
    try { return await fn(brain, calls); } finally { Math.random = rnd; rmSync(dir, { recursive: true, force: true }); }
  };
  const tacticOf = (calls) => calls.find((c) => c.questions.tactic)?.questions.tactic.criteria ?? null;
  const dump = (calls) => calls.map((c) => JSON.stringify(c.questions) + JSON.stringify(c.state)).join('|');
  const ROOM = ['#############', '#...........#', '#...........#', '#..@...A....#', '#...........#', '#...........#', '#############'];
  const TWO = ['#############', '#...........#', '#...A.......#', '#..@...A....#', '#...........#', '#...........#', '#############'];
  const hunting = (g) => { for (const a of g.adversaries) a.mode = 'chase'; return g; };

  // a. The rules text carries the live numbers.
  const rulesOf = () => withBrain(hunting(arena(ROOM)), async (b, calls) => { await b.takeTurn(); return calls[0].state.game; });
  const before = skillConfig();
  const base = await rulesOf();
  check(/loses 1 hp and is knocked back and stunned 2 steps, so your next strike lands before it can claw/.test(base), `combat rule: stun clause (${base})`);
  check(/gone for good and may drop a coin\./.test(base) && !/every time|half the time/.test(base) && /claw needs 2 steps to recharge, and your shield stops it 60% of the time/.test(base), 'combat rule: coin, recharge and shield at the defaults');
  try {
    configureSkills({ ...before, stunTicks: 3, clawCooldown: 4, shieldChance: 0.4, coinDropChance: 0.5, swordDamage: 2 });
    const live = await rulesOf();
    check(/loses 2 hp and is knocked back and stunned 3 steps/.test(live) && /may drop a coin/.test(live) && !/half the time/.test(live) && /needs 4 steps to recharge/.test(live) && /stops it 40% of the time/.test(live), `combat rule follows the settings (${live})`);
    configureSkills({ ...before, stunTicks: 1 });
    check(!/before it can claw/.test(await rulesOf()), 'combat rule: no "next strike before it claws" claim with a 1-step stun');
    // A sword cooldown of 3 against a 2-step stun: the duels below give a claw between the strikes (review of P3).
    configureSkills({ ...before, swordCooldown: 3 });
    check(!/before it can claw/.test(await rulesOf()), 'combat rule: no "next strike before it claws" claim when the sword recharges slower than the stun');
    configureSkills({ ...before, clawDamage: 2 });
    check(/claw costs 2 lives/.test(await rulesOf()), 'rules: the claw damage follows the clawDamage setting');
  } finally { configureSkills(before); }

  // b. Engage's fact: strikes needed from the visible hp; the clear sentence only for the one ghost ever seen.
  const solo = await withBrain(hunting(arena(ROOM)), async (b, calls) => { await b.takeTurn(); return tacticOf(calls); });
  check(solo?.engage && /2 strikes dispel it; expect at most one claw at you\./.test(solo.engage), `engage fact has strikes and the claw line (${solo?.engage})`);
  check(/Dispelling it may clear the dungeon \(a win\)\./.test(solo?.engage ?? ''), 'engage fact: a lone adversary may clear the dungeon');
  // Twin: a second ghost sealed away and never seen changes nothing.
  const SEALED = ['#############', '#...........#', '#...........#', '#..@...A....#', '#...........#', '#...........#', '#############', '#...........#', '#.....A.....#', '#############'];
  const lone = await withBrain(hunting(arena(SEALED.map((r, i) => (i > 5 ? r.replace('A', '.') : r)))), async (b, calls) => { await b.takeTurn(); return dump(calls); });
  const hidden = await withBrain(hunting(arena(SEALED)), async (b, calls) => { await b.takeTurn(); return dump(calls); });
  check(lone === hidden, 'a second ghost never seen does not change the request');
  // Two in sight: no sentence. Two seen, one gone from sight: still none (remembered, and never "the only one").
  const two = await withBrain(hunting(arena(TWO)), async (b, calls) => { await b.takeTurn(); return tacticOf(calls); });
  check(two?.engage && /strikes? dispel/.test(two.engage) && !/clear the dungeon/.test(two.engage), `two ghosts in sight: strikes but no clear sentence (${two?.engage})`);
  check(!/at most one claw/.test(two?.engage ?? ''), `two ghosts in sight: no "at most one claw" claim (${two?.engage})`);
  // The claw clause and the coin in the tactic priority follow the settings.
  try {
    configureSkills({ ...before, swordCooldown: 3 });
    const slow = await withBrain(hunting(arena(ROOM)), async (b, calls) => { await b.takeTurn(); return tacticOf(calls); });
    check(slow?.engage && !/at most one claw/.test(slow.engage), `sword cooldown 3 > stun 2: no claw claim (${slow?.engage})`);
    configureSkills({ ...before, coinDropChance: 0 });
    const prio = await withBrain(hunting(arena(ROOM)), async (b, calls) => { await b.takeTurn(); return JSON.stringify(calls.find((c) => c.questions.tactic)?.questions.tactic.instructions); });
    check(!/may drop a coin|pays a coin/.test(prio ?? 'pays a coin'), `coinDropChance 0: the tactic priorities promise no coin (${prio})`);
  } finally { configureSkills(before); }
  {
    // A ghost the explorer dispelled no longer counts: the lone survivor in sight may still clear the dungeon.
    const g = hunting(arena(TWO));
    const dir = mkdtempSync(join(tmpdir(), 'jev-check-'));
    const calls = [];
    const base = stubAsk(calls);
    const ask = async (req) => {
      const out = await base(req);
      const strike = Object.keys(req.questions.skill?.criteria ?? {}).find((k) => k.startsWith('sword_strike'));
      if (strike) out.skill = { choice: strike, probabilities: { [strike]: 1 }, confidence: 1 };
      return out;
    };
    const brain = new ExplorerBrain(new KnownWorld(g), { ask, memoryDir: pathToFileURL(dir + '/') });
    const rnd = Math.random; Math.random = () => 0.5;
    try {
      await brain.takeTurn(); // both seen
      const a1 = g.adversaries.find((a) => a.id === 'a1');
      a1.takeHit(a1.hp - 1, [0, 0]); // 1 hp left
      a1.pos = [g.pos[0], g.pos[1] - 1];
      await brain.takeTurn(); // strikes a1: dispelled
      check(!g.adversaries.some((a) => a.id === 'a1'), 'setup: the explorer dispelled a1');
      await brain.noteHit('a2'); // a re-decision on the next tick
      const n = calls.length;
      await brain.takeTurn();
      const t = tacticOf(calls.slice(n));
      check(/clear the dungeon/.test(t?.engage ?? ''), `after dispelling a1, the lone a2 in sight may clear the dungeon (${t?.engage})`);
    } finally { Math.random = rnd; rmSync(dir, { recursive: true, force: true }); }
  }
  {
    const g = hunting(arena(TWO));
    await withBrain(g, async (b, calls) => {
      await b.takeTurn(); // both seen; engage taken
      g.adversaries = g.adversaries.filter((a) => a.id !== 'a1'); // a1 is out of sight now (frozen in memory)
      await b.noteHit('a2'); // a life lost during a tactic: the next tick asks again
      const n = calls.length;
      await b.takeTurn();
      const t = tacticOf(calls.slice(n));
      check(t !== null, 'the re-decision asks the tactic question');
      check(t === null || !/clear the dungeon/.test(t.engage ?? ''), `a ghost seen earlier removes the clear sentence (${t?.engage})`);
    });
  }

  // c. Every mood may strike an adjacent adversary when the sword is ready.
  for (const [id, m] of Object.entries(SENTIMENTS)) {
    check(/Strike an adjacent adversary whenever the sword is ready/.test(m.skill_priority) && !/only if|that blocks your way|that one hit dispels/.test(m.skill_priority), `${id}: skill_priority allows any adjacent strike (${m.skill_priority})`);
  }

  // d. Stubbed duels: a hunting ghost (2 hp, claw cooldown 2) against a sword-only explorer, 24 placements.
  const decide = async ({ state, questions }) => {
    const out = {};
    if (questions.next_move) {
      const t = state.explorer.in_sight ? state.explorer.position : state.last_seen.cell;
      const opts = Object.keys(questions.next_move.criteria);
      const sc = (d) => Math.abs(state.self.position[0] + DIRS[d][0] - t[0]) + Math.abs(state.self.position[1] + DIRS[d][1] - t[1]);
      const c = opts.reduce((best, d) => (sc(d) < sc(best) ? d : best));
      out.next_move = { choice: c, probabilities: { [c]: 1 }, confidence: 1 };
    }
    if (questions.skill) { const k = Object.keys(questions.skill.criteria).filter((x) => x !== 'none'); const c = k[0] ?? 'none'; out.skill = { choice: c, probabilities: { [c]: 1 }, confidence: 1 }; }
    if (questions.search_approach) out.search_approach = { choice: 'sweep_last_seen', probabilities: {}, confidence: 1 };
    if (questions.keep_hunting) out.keep_hunting = { noul: 0.9 };
    return out;
  };
  const man = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  // policy 'hold': walk to 2 steps from it and wait for it to step in (what engage's target says), strike when
  // adjacent, close in on a stunned one. 'walk': keep walking at it (the target engage does not choose).
  async function duel(policy, row, gx) {
    const m = ['###############', '#.............#', '#.............#', '#..@..........#', '#.............#', '#.............#', '###############'].map((r) => r.split(''));
    m[row][gx] = 'A';
    const game = arena(m.map((r) => r.join('')));
    game.adversaries[0].mode = 'chase';
    game.health = game.maxHealth = 9;
    const world = new KnownWorld(game);
    const sword = buildSkillSet(['sword_strike']);
    const r = { strikes: 0, claws: 0, clawsBetween: 0, dispelled: false };
    let atFirst = 0;
    for (let t = 0; t < 60 && !r.dispelled; t++) {
      game.clearTickState();
      const g = world.visibleAdversaries()[0];
      let acted = false;
      if (g && man(world.pos, g.pos) === 1) {
        const dir = Object.keys(DIRS).find((d) => DIRS[d][0] === g.pos[0] - world.pos[0] && DIRS[d][1] === g.pos[1] - world.pos[1]);
        const opt = Object.entries(sword.options({ pos: [...world.pos], facing: world.facing }, { opponentsNear: true, visibleOpponents: [{ id: g.id, pos: g.pos, hp: g.hp, maxHp: g.maxHp }], stunTicks: 2, coinChance: 1 })).find(([, o]) => o.target.dir === dir);
        const ev = opt ? world.useSkill(sword, opt[0]) : null;
        if (ev) {
          r.strikes++; acted = true;
          if (r.strikes === 1) atFirst = r.claws;
          if (r.strikes === 2) r.clawsBetween = r.claws - atFirst;
          if (ev.some((e) => e.type === 'dispelled')) r.dispelled = true;
        }
      }
      if (!acted) {
        const nx = (d) => [world.pos[0] + DIRS[d][0], world.pos[1] + DIRS[d][1]];
        const toward = () => world.legalMoves().filter((d) => d !== 'stay' && man(nx(d), g.pos) >= 1).sort((a, b) => man(nx(a), g.pos) - man(nx(b), g.pos))[0];
        const d0 = g ? man(world.pos, g.pos) : 0;
        if (g && (policy === 'walk' || d0 > 2 || (r.strikes > 0 && d0 === 2))) world.move(toward()); else world.move('stay');
      }
      sword.turnPassed();
      const { events } = await stepAdversaries(game, { decide });
      r.claws += events.filter((e) => e.type === 'hit').length;
    }
    return r;
  }
  for (const policy of ['hold', 'walk']) {
    const rs = [];
    for (const row of [2, 3, 4]) for (let gx = 6; gx <= 13; gx++) rs.push(await duel(policy, row, gx));
    check(rs.every((r) => r.dispelled && r.strikes === 2), `${policy} duels: 2 strikes dispel a 2 hp ghost in all ${rs.length}`);
    check(rs.every((r) => r.clawsBetween === 0), `${policy} duels: no claw between the first and the second strike`);
    check(rs.every((r) => r.claws <= 1), `${policy} duels: at most one claw per duel`);
    if (policy === 'hold') check(rs.every((r) => r.claws === 0), 'hold duels: no claw at all holding the 2-step gap');
  }
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('check-skills: all checks passed');
