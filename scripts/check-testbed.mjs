// Checks for the testbed arena (src/testbed.js): config parsing and validation, arena shape,
// determinism, props, adversary placement, and stubbed explorer + adversary ticks (no Jev, free).
// Run from the dungeon-game directory: node scripts/check-testbed.mjs

// Tripwire: every Run here gets stubbed ask/decide; a missed stub would call the paid Jev API.
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { DIRS, SIGHT_RANGE, hasLineOfSight } from '../src/dungeon.js';
import { buildArena, normalizeConfig, explorerSkillSetOf, ghostSkillSetOf, TestbedError } from '../src/testbed.js';
import { buildSkillSet } from '../src/skills/loadouts.js';
import { newTestGame } from '../src/turn.js';
import { ALERT_STEPS } from '../src/characters/adversary/adversary.js';
import { situation } from '../src/characters/explorer/perception.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { SOLID_KINDS, SMALL_KINDS } from '../src/props/catalog.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let failures = 0;
const fail = (msg) => {
  failures++;
  if (failures <= 25) console.error('FAIL:', msg);
};
const check = (ok, msg) => ok || fail(msg);
const throwsBad = (cfg, label) => {
  try {
    buildArena(cfg);
    fail(`${label}: expected a TestbedError`);
  } catch (err) {
    check(err instanceof TestbedError, `${label}: threw ${err.constructor.name} (${err.message}), not TestbedError`);
  }
};
const reachable = (d) => {
  const seen = new Set([d.start.join()]);
  const q = [d.start];
  for (let i = 0; i < q.length; i++) {
    for (const [dx, dy] of Object.values(DIRS)) {
      const n = [q[i][0] + dx, q[i][1] + dy];
      if (d.tiles[n[1]]?.[n[0]] === '.' && !seen.has(n.join())) { seen.add(n.join()); q.push(n); }
    }
  }
  return seen;
};
const floorCount = (d) => d.tiles.join('').split('').filter((c) => c === '.').length;

// 1. Config parsing: defaults, URL strings, validation.
{
  const d = normalizeConfig({});
  check(d.size[0] === 11 && d.numAdversaries === 1 && d.props === 'none' && d.treasure === null, 'defaults');
  const u = normalizeConfig({ testbed: '', size: '9x7', numAdversaries: '2', seed: '5', treasure: 'far', start: '2,3', adversaries: '6,6;7,2', adversariesInSight: 'false' });
  check(u.size[0] === 9 && u.size[1] === 7 && u.numAdversaries === 2 && u.seed === 5 && u.treasure === 'far', 'URL string coercion');
  check(u.start[0] === 2 && u.start[1] === 3 && u.adversaries.length === 2 && u.adversariesInSight === false, 'URL cells and booleans');
  check(normalizeConfig({ size: 6 }).size.join() === '6,6', 'size as one number');
  check(d.characters === 'standard', 'characters defaults to standard');
  check(normalizeConfig({ characters: 'mixed' }).characters === 'mixed' && normalizeConfig({ characters: 'timid' }).characters === 'timid', 'characters: string forms');
  { const t = buildArena({ map: ['#######', '#@.A.A#', '#.....#', '#..A..#', '#######'], characters: ['timid', 'ambusher'] }).adversaries; check(t.map((a) => a.character).join() === 'timid,ambusher,timid' && t[0].memory.character.id === 'timid', 'characters: applied per ghost in id order, cycled'); }
  check(buildArena({ numAdversaries: 2 }).adversaries.every((a) => a.character === 'standard'), 'characters: default standard');
  check(normalizeConfig({ characters: 'ambusher;timid' }).characters.join() === 'ambusher,timid', 'characters: URL list form');
  check(normalizeConfig({ characters: ['rover', 'standard'] }).characters.join() === 'rover,standard', 'characters: array form');
  check(buildArena({ characters: 'pursuer' }).config.characters === 'pursuer', 'arena returns characters');
  throwsBad({ characters: 'villain' }, 'bad character id');
  throwsBad({ characters: ['timid', 'villain'] }, 'bad character id in list');
  throwsBad({ characters: [] }, 'empty characters list');
  throwsBad({ size: [2, 9] }, 'size too small');
  throwsBad({ size: [61, 9] }, 'size too big');
  throwsBad({ numAdversaries: 9 }, 'too many adversaries');
  throwsBad({ bogus: 1 }, 'unknown key');
  throwsBad({ props: 'lots' }, 'bad props preset');
  throwsBad({ props: [{ kind: 'dragon', x: 1, y: 1 }] }, 'bad prop kind');
  throwsBad({ start: [0, 0] }, 'start on wall');
  throwsBad({ size: [5, 5], numAdversaries: 8, minAdversaryGap: 4 }, 'not enough room for adversaries');
  throwsBad({ map: ['#####', '#.@.#', '#####'] }, 'map too small');
  throwsBad({ map: ['######', '#.@...', '#....#', '#....#', '######'] }, 'map border open');
  throwsBad({ map: ['#####', '#...#', '#...#', '#...#', '#####'] }, 'map without start');
  throwsBad({ map: ['#####', '#@#T#', '#.#.#', '#.#.#', '#####'] }, 'unreachable chest');
}

// 2. Plain arena: shape, start, chest, adversaries, determinism.
{
  const { dungeon: d, adversaries } = buildArena({ size: [9, 7], numAdversaries: 2, seed: 3 });
  check(d.width === 11 && d.height === 9 && d.tiles.length === 9 && d.tiles.every((r) => r.length === 11), 'size [9,7] -> 11x9 with wall ring');
  check(d.tiles[0] === '#'.repeat(11) && d.tiles.every((r) => r[0] === '#' && r[10] === '#'), 'wall ring');
  check(floorCount(d) === 63, 'empty arena is all floor inside');
  check(d.start.join() === '5,4', `centre start, got ${d.start}`);
  check(d.treasure === null && d.props.length === 0 && d.decor.length === 0, 'no chest, no props by default');
  check(adversaries.length === 2 && adversaries.every((a, i) => a.id === `a${i + 1}`), 'adversary ids');
  check(adversaries.every((a) => Object.keys(a).join() === 'id,pos,mode,budget,lastSeen,goal' && a.mode === 'patrol'), 'contracted adversary shape');
  check(adversaries.every((a) => Math.abs(a.pos[0] - d.start[0]) + Math.abs(a.pos[1] - d.start[1]) >= 4), 'minAdversaryGap 4 (open room: path = Manhattan)');
  const again = buildArena({ size: [9, 7], numAdversaries: 2, seed: 3 });
  check(JSON.stringify(again) === JSON.stringify(buildArena({ size: [9, 7], numAdversaries: 2, seed: 3 })) &&
    JSON.stringify(again.adversaries) === JSON.stringify(adversaries), 'same seed, same arena');
  const far = buildArena({ size: [9, 7], treasure: 'far', numAdversaries: 0 }).dungeon;
  check(far.treasure && Math.abs(far.treasure[0] - 5) + Math.abs(far.treasure[1] - 4) === 7, `treasure 'far' at max path distance, got ${far.treasure}`);
  const fixed = buildArena({ size: [9, 9], start: [1, 1], treasure: [9, 9], adversaries: [[5, 5], [9, 1]] });
  check(fixed.dungeon.start.join() === '1,1' && fixed.dungeon.treasure.join() === '9,9', 'explicit start and chest');
  check(fixed.adversaries.map((a) => a.pos.join()).join(';') === '5,5;9,1', 'explicit adversary cells');
  check(buildArena({ size: [9, 9], numAdversaries: 0 }).adversaries.length === 0, 'zero adversaries');
  // In-sight / out-of-sight placement (needs cover, so use a map with a pillar).
  const sightMap = ['#########', '#.......#', '#.......#', '#..@....#', '#.......#', '#....##.#', '#....##.#', '#.......#', '#########'];
  const seen = buildArena({ map: sightMap, numAdversaries: 3, minAdversaryGap: 2, adversariesInSight: true });
  const hidden = buildArena({ map: sightMap, numAdversaries: 2, minAdversaryGap: 2, adversariesInSight: false });
  check(hidden.adversaries.length === 2 && seen.adversaries.length === 3, 'in/out of sight counts');
  const sees = (d, c) => Math.hypot(c[0] - d.start[0], c[1] - d.start[1]) <= SIGHT_RANGE && hasLineOfSight(d, d.start, c);
  check(seen.adversaries.every((a) => sees(seen.dungeon, a.pos)), 'adversariesInSight: true');
  check(hidden.adversaries.every((a) => !sees(hidden.dungeon, a.pos)), 'adversariesInSight: false');
}

// 3. Props: none / few / many / explicit list, always connected, start and chest clear.
{
  for (const props of ['few', 'many']) {
    let total = 0, solid = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { dungeon: d, adversaries } = buildArena({ size: [12, 10], props, treasure: 'far', numAdversaries: 2, seed });
      total += d.props.length;
      solid += d.props.filter((p) => p.solid).length;
      check(reachable(d).size === floorCount(d), `${props} seed ${seed}: floor cut off`);
      check(d.props.every((p) => (p.solid ? SOLID_KINDS : SMALL_KINDS).includes(p.kind) && (d.tiles[p.y][p.x] === '#') === p.solid), `${props} seed ${seed}: prop kinds / tiles`);
      check(!d.props.some((p) => Math.abs(p.x - d.start[0]) <= 1 && Math.abs(p.y - d.start[1]) <= 1), `${props} seed ${seed}: prop next to start`);
      check(!d.props.some((p) => p.solid && Math.abs(p.x - d.treasure[0]) <= 1 && Math.abs(p.y - d.treasure[1]) <= 1), `${props} seed ${seed}: solid prop next to chest`);
      check(adversaries.every((a) => d.tiles[a.pos[1]][a.pos[0]] === '.'), `${props} seed ${seed}: adversary on a solid prop`);
    }
    check(solid > 0 && total > solid, `${props}: produced solid and small props (${solid}/${total})`);
    console.log(`props '${props}': ${(total / 40).toFixed(1)} props per 12x10 arena (${(solid / 40).toFixed(1)} solid)`);
  }
  const few = buildArena({ size: [12, 10], props: 'few', seed: 7 }).dungeon.props.filter((p) => p.solid).length;
  const many = buildArena({ size: [12, 10], props: 'many', seed: 7 }).dungeon.props.filter((p) => p.solid).length;
  check(many > few, `'many' places more solid props than 'few' (${many} vs ${few})`);
  const list = buildArena({ size: [9, 9], props: [{ kind: 'crates', x: 3, y: 3 }, { kind: 'skull', x: 7, y: 7 }] }).dungeon;
  check(list.tiles[3][3] === '#' && list.tiles[7][7] === '.' && list.props.length === 2, 'explicit props: solid blocks, small stays floor');
  const fresh = buildArena({ size: [9, 9], props: [{ kind: 'fountain', x: 3, y: 3 }, { kind: 'forge', x: 5, y: 3 }, { kind: 'anvil', x: 3, y: 6 }, { kind: 'goblet', x: 6, y: 6 }] }).dungeon;
  check(fresh.tiles[3][3] === '#' && fresh.tiles[3][5] === '#' && fresh.tiles[6][3] === '.' && fresh.tiles[6][6] === '.' && fresh.props.length === 7, 'explicit props: fountain, forge (solid, 2x2 = 4 cells) and anvil, goblet (small)');
  const fg = fresh.props.filter((p) => p.kind === 'forge');
  check(fg.length === 4 && fg.filter((p) => p.w).length === 1 && fg.find((p) => p.w).x === 5 && fg.find((p) => p.w).y === 3 && fg.find((p) => p.w).w === 2 && fg.find((p) => p.w).h === 2 &&
    fg.every((p) => p.solid && fresh.tiles[p.y][p.x] === '#') && fg.filter((p) => p.part).length === 3, 'forge: 2x2 footprint, anchor carries w/h, 3 parts, all solid');
  const f6 = buildArena({ size: [9, 9], props: [{ kind: 'forge', x: 2, y: 2, w: 3, h: 2, flip: true }] }).dungeon;
  check(f6.props.length === 6 && f6.props.every((p) => p.flip) && f6.tiles[3][4] === '#' && f6.tiles[4][2] === '.', 'forge 3x2: six cells, flip kept');
  for (const bad of [{ w: 3, h: 3 }, { w: 1, h: 2 }, { x: 9, y: 9 }, { x: 1, y: 1 }]) {
    let threw = false;
    try { buildArena({ size: [9, 9], start: [1, 1], props: [{ kind: 'forge', x: 8, y: 8, ...bad }] }); } catch (e) { threw = e instanceof TestbedError; }
    check(threw, `forge ${JSON.stringify(bad)} is rejected`);
  }
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = buildArena({ size: [12, 10], props: 'many', seed }).dungeon.props.concat(buildArena({ map: ['#######', '#@.p.T#', '#.ppp.#', '#.....#', '#######'], seed }).dungeon.props);
    check(r.every((p) => p.kind !== 'forge'), `random and ASCII props never make a lone forge (seed ${seed})`);
  }
}

// 4. ASCII map.
{
  const { dungeon: d, adversaries } = buildArena({ map: ['##########', '#@..p...T#', '#.##.###.#', '#....A..s#', '##########'] });
  check(d.width === 10 && d.height === 5 && d.start.join() === '1,1' && d.treasure.join() === '8,1', 'map size, start, chest');
  check(adversaries.length === 1 && adversaries[0].pos.join() === '5,3', 'map adversary');
  check(d.tiles[1][4] === '#' && d.props.some((p) => p.x === 4 && p.y === 1 && p.solid), 'map solid prop');
  check(d.props.some((p) => p.x === 8 && p.y === 3 && !p.solid) && d.tiles[3][8] === '.', 'map small prop');
  check(buildArena({ map: '#####/#@..#/#...#/#..A#/#####' }).adversaries.length === 1, 'map as one "/"-separated string');
}

// 5. Stubbed play: explorer (injected `ask`) + adversary brains (injected `decide`), ~25 ticks per scenario.
//    Covers the fully lit, chest-less arena with no frontier, which a normal dungeon never has.
const dir = mkdtempSync(join(tmpdir(), 'testbed-check-'));
const url = pathToFileURL(dir + '/');
let explorerCalls = 0, adversaryCalls = 0;
const first = (q) => Object.keys(q.criteria ?? {})[0];
const stubAnswers = (questions) => Object.fromEntries(Object.entries(questions).map(([k, q]) =>
  [k, q.type === 'noul' ? { noul: 0.9 } : { choice: first(q), probabilities: { [first(q)]: 1 }, confidence: 1 }]));
const ask = async ({ questions }) => { explorerCalls++; return stubAnswers(questions); };
const decide = async ({ questions }) => { adversaryCalls++; return stubAnswers(questions); };
const scenarios = [
  { name: 'empty 9x9, no chest, no adversaries', config: { size: [9, 9], numAdversaries: 0 } },
  { name: 'empty 9x9, no chest, 2 adversaries', config: { size: [9, 9], numAdversaries: 2 } },
  { name: '15x11 with props, far chest, 3 adversaries', config: { size: [15, 11], props: 'many', treasure: 'far', numAdversaries: 3, seed: 4 } },
  { name: 'corridor map with chest out of light', config: { map: ['########################', '#@.....................#', '#.####################T#', '#......A...............#', '########################'] } },
];
for (const { name, config } of scenarios) {
  try {
    const run = newTestGame(config, { ask, decide, memoryDir: url, dir: url });
    const { game } = run;
    const v = run.view();
    check(v.testbed === true && v.width === game.dungeon.width && v.adversaries.length === game.adversaries.length, `${name}: view`);
    if (!config.map && config.size[0] <= 13) {
      let lit = 0;
      for (let y = 0; y < game.dungeon.height; y++) for (let x = 0; x < game.dungeon.width; x++) if (game.dungeon.tiles[y][x] === '.' && game.isKnown([x, y])) lit++;
      check(lit === game.floorCount, `${name}: small arena floor fully lit at step 0 (${lit}/${game.floorCount})`);
    }
    check(typeof situation(new KnownWorld(game)).surroundings.chest === 'string', `${name}: situation`);
    let ticks = 0;
    for (; ticks < 25 && !game.won && !game.lost; ticks++) {
      await run.playTurn();
    }
    console.log(`${name}: ${ticks} ticks, pos ${game.pos}, won ${game.won}, lost ${game.lost}, health ${game.health}`);
  } catch (err) {
    fail(`${name}: threw ${err.stack}`);
  }
}

// 5b. Skill knobs: explorerSkills / ghostSkills / ghostHp parse, validate and reach buildArena's config.
{
  const d = normalizeConfig({});
  check(d.explorerSkills === 'default' && d.ghostSkills === 'default' && d.ghostHp === null, 'skills: defaults');
  check(explorerSkillSetOf(d) === 'explorer' && ghostSkillSetOf(d) === 'ghost', 'skills: default set names');
  check(normalizeConfig({ explorerSkills: 'none' }).explorerSkills === 'none' && explorerSkillSetOf(normalizeConfig({ explorerSkills: 'none' })) === 'none', 'skills: explorerSkills none');
  check(normalizeConfig({ explorerSkills: 'sword_strike;shield_block' }).explorerSkills.join() === 'sword_strike,shield_block', 'skills: URL list');
  check(normalizeConfig({ explorerSkills: ['claw_strike'] }).explorerSkills.join() === 'claw_strike' && normalizeConfig({ explorerSkills: 'sword_strike' }).explorerSkills.join() === 'sword_strike', 'skills: array and single id');
  check(normalizeConfig({ explorerSkills: [] }).explorerSkills === 'none', 'skills: empty list is none');
  check(buildSkillSet(explorerSkillSetOf(normalizeConfig({ explorerSkills: 'shield_block' }))).size === 1, 'skills: list builds a skill set');
  check(ghostSkillSetOf(normalizeConfig({ ghostSkills: 'none' })) === 'none' && normalizeConfig({ ghostSkills: 'none' }).ghostSkills === 'none', 'skills: ghostSkills none');
  check(normalizeConfig({ ghostHp: '3' }).ghostHp === 3, 'skills: ghostHp from a URL string');
  throwsBad({ explorerSkills: 'nope' }, 'explorerSkills unknown id');
  throwsBad({ explorerSkills: ['sword_strike', 'sword_strike'] }, 'explorerSkills duplicate');
  throwsBad({ explorerSkills: ['sword_strike', 'shield_block', 'claw_strike', 'a', 'b'] }, 'explorerSkills over 4');
  throwsBad({ explorerSkills: 5 }, 'explorerSkills wrong type');
  throwsBad({ ghostSkills: 'claws' }, 'ghostSkills bad value');
  throwsBad({ ghostHp: 0 }, 'ghostHp 0');
  throwsBad({ ghostHp: 6 }, 'ghostHp 6');
  throwsBad({ ghostHp: 1.5 }, 'ghostHp fraction');
  const a = buildArena({ explorerSkills: ['sword_strike'], ghostSkills: 'none', ghostHp: 4 });
  check(a.config.explorerSkills.join() === 'sword_strike' && a.config.ghostSkills === 'none' && a.config.ghostHp === 4, 'skills: buildArena returns the knobs in config');
  check(JSON.stringify(buildArena({ seed: 3 }).dungeon) === JSON.stringify(buildArena({ seed: 3, explorerSkills: 'none', ghostHp: 5 }).dungeon), 'skills: knobs do not change the arena');
}

// 6. Pack alert (P0 coverage): one ghost spots the explorer while the other is within ALERT_STEPS
//    path steps behind a wall, so alertNearby / team sight runs. Must not throw, must emit 'alerted'.
{
  const config = { map: ['###########', '#....#....#', '#.@..#..A.#', '#..A.#....#', '#....#....#', '#.........#', '###########'], seed: 1 };
  try {
    const run = newTestGame(config, { ask, decide, memoryDir: url, dir: url });
    const { game } = run;
    check(game.adversaries.length === 2, 'alert scenario: 2 adversaries');
    check(ALERT_STEPS >= 8, `alert scenario: second ghost must be within ALERT_STEPS (${ALERT_STEPS})`);
    const kinds = new Set();
    let ticks = 0;
    for (; ticks < 30 && !game.won && !game.lost; ticks++) (await run.playTurn()).events.forEach((e) => kinds.add(e.type));
    check(kinds.has('spotted') && kinds.has('alerted'), `alert scenario: expected spotted + alerted events, got ${[...kinds].join(',') || 'none'}`);
    console.log(`pack alert: ${ticks} ticks, events ${[...kinds].join(',')}`);
  } catch (err) {
    fail(`pack alert scenario: threw ${err.stack}`);
  }
}
// 6b. Scripted adjacency: a ghost next to the explorer, the stub picks sword_strike_<dir>. The ghost takes the
//     hit (struck event through Run.playTurn, hp down, stunned) and no life is lost by a touch alone.
{
  const strikeAsk = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
    if (q.type === 'noul') return [k, { noul: 0.9 }];
    const keys = Object.keys(q.criteria);
    const c = k === 'skill' ? (keys.find((x) => x.startsWith('sword_strike_')) ?? 'none') : keys[0];
    return [k, { choice: c, probabilities: { [c]: 1 }, confidence: 1 }];
  }));
  try {
    const run = newTestGame({ map: ['#######', '#.....#', '#.@A..#', '#.....#', '#######'], seed: 1, ghostHp: 3 }, { ask: strikeAsk, decide, memoryDir: url, dir: url });
    const ghost = run.game.adversaries[0];
    check(ghost.hp === 3, `adjacency: ghostHp 3 reached the ghost (${ghost.hp})`);
    const turn = await run.playTurn();
    check(turn.events.some((e) => e.type === 'struck' && e.id === 'a1'), `adjacency: no struck event in playTurn (${turn.events.map((e) => e.type)})`);
    check(ghost.hp === 2 && ghost.stun > 0, `adjacency: ghost hp ${ghost.hp} stun ${ghost.stun}`);
    check(run.game.health === run.game.maxHealth, 'adjacency: a strike on a ghost cost the explorer a life');
    const none = newTestGame({ map: ['#######', '#.....#', '#.@A..#', '#.....#', '#######'], seed: 1, ghostSkills: 'none', explorerSkills: 'none' }, { ask: strikeAsk, decide, memoryDir: url, dir: url });
    check(none.explorer.memory.skills.length === 0 && none.game.adversaries[0].skills.skills.length === 0, 'adjacency: skills none reach the explorer and the ghost');
    console.log('adjacency: sword strike hits the ghost, struck event reaches playTurn');
  } catch (err) {
    fail(`adjacency scenario: threw ${err.stack}`);
  }
}
check(explorerCalls > 0, 'stub explorer was asked');
// 7. Coins: the testbed `coins` option (count, cell list, ASCII 'c'), and the opening coins of a generated
//    dungeon (src/coins.js): own PRNG stream, count from the floor area, spread over rooms, never on the
//    start, the chest or a small prop, and the layout and ghost spawns unchanged.
{
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  check(buildArena({}).dungeon.coins.length === 0, 'coins: default arena has no coins');
  const five = buildArena({ size: '9x9', coins: 5, props: 'few', treasure: 'far' }).dungeon;
  check(five.coins.length === 5, `coins: count 5 placed ${five.coins.length}`);
  check(new Set(five.coins.map(String)).size === 5, 'coins: two coins share a cell');
  for (const c of five.coins) {
    check(five.tiles[c[1]][c[0]] === '.', `coins: ${c} is not floor`);
    check(!same(c, five.start) && !same(c, five.treasure), `coins: ${c} on the start or chest`);
    check(!five.props.some((p) => !p.solid && p.x === c[0] && p.y === c[1]), `coins: ${c} on a small prop`);
  }
  check(JSON.stringify(buildArena({ size: '9x9', coins: 5, props: 'few', treasure: 'far' }).dungeon.coins) === JSON.stringify(five.coins), 'coins: not deterministic');
  // Coins come from their own stream: the arena itself (props, ghosts, chest) is the same with or without them.
  const none = buildArena({ size: '9x9', coins: 0, props: 'few', treasure: 'far' });
  const withC = buildArena({ size: '9x9', coins: 5, props: 'few', treasure: 'far' });
  check(JSON.stringify({ ...none.dungeon, coins: 0 }) === JSON.stringify({ ...withC.dungeon, coins: 0 }) &&
    JSON.stringify(none.adversaries) === JSON.stringify(withC.adversaries), 'coins: placing coins changed the arena');
  check(JSON.stringify(buildArena({ coins: '2,2;3,3' }).dungeon.coins) === '[[2,2],[3,3]]', 'coins: cell list (URL form)');
  check(JSON.stringify(buildArena({ coins: [[2, 2]] }).dungeon.coins) === '[[2,2]]', 'coins: cell list (JSON form)');
  check(JSON.stringify(buildArena({ map: ['#######', '#@..c.#', '#.....#', '#.....#', '#######'] }).dungeon.coins) === '[[4,1]]', "coins: ASCII 'c'");
  throwsBad({ coins: 61 }, 'coins 61');
  throwsBad({ coins: -1 }, 'coins -1');
  throwsBad({ coins: [[0, 0]] }, 'coin on the wall');
  throwsBad({ coins: [[6, 6]] }, 'coin on the start');
  // A Run starts with the arena's coins as piles; stepping onto one picks it up.
  const run = newTestGame({ size: '5x5', numAdversaries: 0, coins: [[4, 3]] }, { ask: async () => ({}), decide: async () => ({}) });
  check(JSON.stringify(run.game.coinPiles) === '[[4,3]]', 'coins: Run did not start with the arena coins');
  run.game.applyMove('right');
  check(run.game.coins === 1 && run.game.coinPiles.length === 0, 'coins: picking up an opening coin');

  const { generateDungeon } = await import('../src/dungeon.js');
  const { spawnCoins, configureCoins, FLOOR_PER_COIN, MAX_COINS } = await import('../src/coins.js');
  const { spawnAdversaries } = await import('../src/characters/adversary/adversary.js');
  const { newGame } = await import('../src/turn.js');
  let spreadOk = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const d = generateDungeon(seed);
    const coins = spawnCoins(d);
    let floor = 0;
    for (const row of d.tiles) for (const c of row) if (c === '.') floor++;
    const want = Math.min(MAX_COINS, Math.round(floor / FLOOR_PER_COIN));
    if (coins.length !== want) fail(`coins seed ${seed}: ${coins.length} coins, wanted ${want}`);
    if (JSON.stringify(spawnCoins(d)) !== JSON.stringify(coins)) fail(`coins seed ${seed}: not deterministic`);
    if (new Set(coins.map(String)).size !== coins.length) fail(`coins seed ${seed}: two coins share a cell`);
    for (const c of coins) {
      if (d.tiles[c[1]][c[0]] !== '.') fail(`coins seed ${seed}: ${c} is not floor`);
      if (same(c, d.start) || same(c, d.treasure)) fail(`coins seed ${seed}: ${c} on the start or chest`);
      if (d.props.some((p) => !p.solid && p.x === c[0] && p.y === c[1])) fail(`coins seed ${seed}: ${c} on a small prop`);
    }
    // Round-robin: with at least as many coins as rooms, every room holding a free cell gets one.
    const roomOf = (c) => d.rooms.findIndex((r) => c[0] >= r.x && c[0] < r.x + r.w && c[1] >= r.y && c[1] < r.y + r.h);
    if (coins.length >= d.rooms.length && new Set(coins.map(roomOf)).size === d.rooms.length) spreadOk++;
    // Generation and ghost spawns never move: same dungeon and ghost cells as a run without coins.
    const run = newGame(seed, { ask: async () => ({}), decide: async () => ({}) });
    if (JSON.stringify(run.game.coinPiles) !== JSON.stringify(coins)) fail(`coins seed ${seed}: the Run's piles differ from spawnCoins`);
    if (JSON.stringify(run.game.adversaries.map((a) => a.pos)) !== JSON.stringify(spawnAdversaries(d).map((a) => a.pos))) fail(`coins seed ${seed}: ghost spawns moved`);
    if (JSON.stringify(run.game.dungeon.tiles) !== JSON.stringify(d.tiles)) fail(`coins seed ${seed}: tiles changed`);
  }
  check(spreadOk > 0, 'coins: no seed spread its coins over every room');
  const was = { maxCoins: MAX_COINS, floorPerCoin: FLOOR_PER_COIN };
  try {
    configureCoins({ maxCoins: 0 });
    check(spawnCoins(generateDungeon(3)).length === 0, 'coins: maxCoins 0 still placed coins');
    configureCoins({ maxCoins: 30, floorPerCoin: 10 });
    check(spawnCoins(generateDungeon(3)).length === 30, 'coins: maxCoins does not cap the count');
  } finally {
    configureCoins(was);
  }
  console.log(`coins: testbed option, ASCII map, 20 generated seeds (${spreadOk} spread over every room)`);
}

// 9. winOnClear: the game is won when the last ghost is gone (a dispel happens in the explorer's turn;
// here the ghost is removed by hand, as resolveAttack does). Off by default; no ghost at the start never wins.
{
  check(normalizeConfig({}).winOnClear === false && normalizeConfig({ winOnClear: 'true' }).winOnClear === true, 'winOnClear: default off, URL string parses');
  const mk = (cfg) => newTestGame({ size: '7x7', seed: 1, ...cfg }, { ask, decide, memoryDir: url, dir: url });
  const on = mk({ numAdversaries: 2, winOnClear: true });
  check(on.view().win_on_clear === true && !on.game.won, 'winOnClear: flag in the view, not won at the start');
  on.game.adversaries.length = 1;
  await on.playTurn();
  check(!on.game.won, 'winOnClear: one ghost left is not a win');
  on.game.adversaries.length = 0;
  await on.playTurn();
  check(on.game.won && on.view().over, 'winOnClear: the last ghost gone wins');
  const off = mk({ numAdversaries: 1 });
  off.game.adversaries.length = 0;
  await off.playTurn();
  check(!off.game.won && off.view().win_on_clear === false, 'winOnClear off: clearing the room does not win');
  const none = mk({ numAdversaries: 0, winOnClear: true });
  await none.playTurn();
  check(!none.game.won, 'winOnClear: an arena with no ghosts never wins by clearing');
  console.log('winOnClear: option, view flag, win on the last ghost');
}

console.log(`stub calls: explorer ${explorerCalls}, adversaries ${adversaryCalls} (no network)`);
rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll testbed checks passed.');
