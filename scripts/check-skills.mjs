// Checks for src/skills/: skill set rules, shape rotation, cooldowns, option gating and fog, the seeded
// block roll, strike resolution on the explorer and on ghosts, and the confidence floor. No Jev, no network.
// Run from the dungeon-game directory: node scripts/check-skills.mjs
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { Game } from '../src/dungeon.js';
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
import { ExplorerBrain } from '../src/characters/explorer/brain.js';
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
const near = { pos: [3, 3], opponentsNear: true, visibleOpponents: [{ id: 'a1', pos: [2, 3] }], hitsLanded: { a1: 1 }, threatNear: { id: 'a1', steps: 1 } };
const opts = set.options(view, near);
check(eq(Object.keys(opts), ['sword_strike_left', 'shield_block']), `options keys ${Object.keys(opts)}`);
check(opts.sword_strike_left.fact.includes('a1') && opts.sword_strike_left.fact.includes('once') && opts.sword_strike_left.fact.length <= 160, 'strike fact names the ghost and the earlier hit');
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
  const g = arena(['#######', '#.....#', '#.....#', '#..@A.#', '#.....#', '#.....#', '#######']);
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
  check(ev2?.some((e) => e.type === 'dispelled') && g.adversaries.length === 0 && g.strikes.at(-1).result === 'dispelled', 'second hit dispels and removes the ghost');
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
  check(skillConfig().coinDropChance === 0.5, 'coinDropChance defaults to 0.5');
  const MAP = ['#######', '#.....#', '#.....#', '#..@A.#', '#.....#', '#.....#', '#######'];
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
    setChance(0.5);
  }
  check(skillConfig().coinDropChance === 0.5, 'coinDropChance restored');
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('check-skills: all checks passed');
