// Checks for the testbed arena (src/testbed.js): config parsing and validation, arena shape,
// determinism, props, adversary placement, and stubbed explorer + adversary ticks (no Jev, free).
// Run from the dungeon-game directory: node scripts/check-testbed.mjs

// Tripwire: every Run here gets stubbed ask/decide; a missed stub would call the paid Jev API.
globalThis.fetch = () => { throw new Error('network call in a check script'); };

import { DIRS, SIGHT_RANGE, hasLineOfSight } from '../src/dungeon.js';
import { buildArena, normalizeConfig, TestbedError } from '../src/testbed.js';
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
check(explorerCalls > 0, 'stub explorer was asked');
console.log(`stub calls: explorer ${explorerCalls}, adversaries ${adversaryCalls} (no network)`);
rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll testbed checks passed.');
