// Several explorers in one Game (WP-C of PLAN-multiplayer-impl): ExplorerState, shared max-only light, personal
// visits and purses, teammates (global positions, never threats, solid for moves and known-path BFS), per-explorer
// strikes / grace / death, KnownWorld(game, id), the `explorers` testbed key, request bytes of the teammates group,
// and a fog twin (hidden tiles outside the shared lit area never change any explorer's request).
// All Jev calls are stubs and the fetch tripwire is installed. Run: JEV_CONFIG=none node scripts/check-explorers.mjs
import { installTripwire } from './lib/tripwire.mjs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Game, ExplorerState } from '../src/dungeon.js';
import { buildArena } from '../src/testbed.js';
import { newTestGame } from '../src/turn.js';
import { Adversary, seesExplorer, visibleAdversaries, stepAdversaries, graceLeft } from '../src/characters/adversary/adversary.js';
import { resolveAttack, EXPLORER } from '../src/skills/resolve.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { knownDistances } from '../src/characters/explorer/known-map.js';
import { situation } from '../src/characters/explorer/perception.js';

const uninstall = installTripwire();
let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('FAIL:', msg); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const root = mkdtempSync(join(tmpdir(), 'jev-explorers-check-'));
let n = 0;
const freshDir = () => pathToFileURL(join(root, String(++n)) + '/');
const mk = () => { const d = freshDir(); mkdirSync(new URL(d).pathname, { recursive: true }); return d; };

// Stub ask: noul 0.9, first option of any choice (deterministic given the option order).
const answer = ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
  if (q.type === 'noul') return [k, { noul: 0.9 }];
  const ids = Object.keys(q.criteria);
  const choice = k === 'skill' ? (ids.includes('none') ? 'none' : ids[0]) : ids[0];
  return [k, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
}));
const seededRandom = () => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; };

function build(config, { ask = async (q) => answer(q), askFor = null } = {}) {
  const dir = mk();
  return newTestGame(config, { ask, askFor, decide: async () => ({}), memoryDir: dir, dir, confidence: { fixedMood: true } });
}

// A long 1-wide corridor: A at x=2, B at x=12 (own light pools), nothing else.
const row = (len, ch = '.') => '#' + ch.repeat(len) + '#';
const corridor = (len = 50) => ['#'.repeat(len + 2), row(len), '#'.repeat(len + 2), '#'.repeat(len + 2), '#'.repeat(len + 2)].map((r, i) => (i === 1 ? '#@' + '.'.repeat(len - 1) + '#' : r));

// 1. Default game: one explorer, legacy fields are the primary's.
{
  const run = build({ map: corridor(), numAdversaries: 0 });
  const g = run.game;
  ok(g.explorers.length === 1 && g.explorers[0] instanceof ExplorerState && g.explorers[0].id === 'explorer', 'default: one explorer with id explorer');
  ok(g.explorer('explorer') === g.explorers[0] && g.explorer() === g.explorers[0] && g.activeExplorers().length === 1, 'default: explorer(id) and activeExplorers');
  g.pos = [5, 1];
  ok(eq(g.explorers[0].pos, [5, 1]) && g.pos === g.explorers[0].pos, 'default: pos is an accessor onto the primary');
  for (const f of ['steps', 'visits', 'trail', 'health', 'maxHealth', 'regenAt', 'graceTicks', 'facing', 'block', 'coins', 'heartAt']) ok(g[f] === g.explorers[0][f], `default: ${f} accessor`);
  const t = g.twin({ pos: [9, 1], health: 1 });
  ok(eq(t.pos, [9, 1]) && t.health === 1 && eq(g.pos, [5, 1]) && g.health === g.maxHealth, 'twin: overriding pos / health leaves the original alone');
  ok(t.explorers[0] !== g.explorers[0] && t.visits === g.visits, 'twin: own ExplorerState, shared objects');
  let threw = false; try { g.explorer('nobody'); } catch { threw = true; }
  ok(threw, 'explorer(unknown id) throws');
  ok(!('teammates' in situation(new KnownWorld(g)).surroundings), 'single explorer: no surroundings.teammates');
}

// 2. Two explorers: shared light, personal state.
{
  const run = build({ map: corridor(), numAdversaries: 0, explorers: [[30, 1]] });
  const g = run.game;
  ok(g.explorers.length === 2 && eq(g.explorers.map((e) => e.id), ['explorer', 'explorer2']) && run.explorers.length === 2 && run.explorer === run.explorers[0].brain, 'two: ids and run.explorers');
  const wa = new KnownWorld(g, 'explorer'), wb = new KnownWorld(g, 'explorer2');
  ok(eq(wa.pos, [1, 1]) && eq(wb.pos, [30, 1]) && wa.id === 'explorer' && wb.id === 'explorer2', 'two: each window reads its own position');
  let same = true;
  for (let x = 0; x < wa.width; x++) for (let y = 0; y < wa.height; y++) if (wa.knownTile([x, y]) !== wb.knownTile([x, y]) || wa.isKnown([x, y]) !== wb.isKnown([x, y])) same = false;
  ok(same, 'two: knownTile / isKnown are the same for both (shared light)');
  ok(wa.isKnown([30, 1]) && wb.isKnown([2, 1]) && !wa.isKnown([20, 1]), 'two: B lit around itself, A sees it; the gap between stays unknown');
  ok(g.light[1][30] === 1 && g.light[1][1] === 1, 'two: both starts fully lit');
  ok(wa.visits !== wb.visits && !('30,1' in wa.visits) && !('1,1' in wb.visits), 'two: visits are personal');
  const known0 = g.knownFloorCount();
  const rb = g.applyMove('left', 1, 'explorer2');
  ok(rb.moved && eq(g.explorer('explorer2').pos, [29, 1]) && g.explorer('explorer2').steps === 1 && g.explorer('explorer').steps === 0, 'two: B steps, A does not');
  ok(wb.steps === 1 && wa.steps === 0 && g.steps === 0, 'two: steps are personal; the legacy field is the primary');
  ok(g.knownFloorCount() >= known0, 'two: light only rises');
  // light is max-only: A walks into B's pool, nothing darkens
  const before = g.light.map((r) => r.slice());
  for (let i = 0; i < 6; i++) g.applyMove('right', 1, 'explorer');
  let rose = true;
  for (let y = 0; y < g.light.length; y++) for (let x = 0; x < g.light[y].length; x++) if (g.light[y][x] < before[y][x]) rose = false;
  ok(rose, 'two: brightness never falls');
  ok(wa.visits !== wb.visits && ('7,1' in wa.visits) && !('7,1' in wb.visits), 'two: A\'s visits hold only A\'s cells');
  ok(g.publicView().explorers?.length === 2 && g.publicView().pos === g.pos, 'two: publicView lists explorers; top level stays the primary');
  ok(!('explorers' in build({ map: corridor(), numAdversaries: 0 }).game.publicView()), 'single: publicView unchanged');
}

// 3. Teammates: global positions, solid, never threats.
{
  const run = build({ map: ['#######', '#@.#..#', '#.##..#', '#.....#', '#######'], numAdversaries: 0, explorers: [[4, 1]] });
  const g = run.game;
  const wa = new KnownWorld(g, 'explorer'), wb = new KnownWorld(g, 'explorer2');
  ok(eq(wa.teammates(), [{ id: 'explorer2', pos: [4, 1] }]) && eq(wb.teammates(), [{ id: 'explorer', pos: [1, 1] }]), 'teammates(): the other explorers, through walls');
  ok(eq(wa.helpReports(), []), 'helpReports(): empty for now');
  ok(wa.visibleAdversaries().length === 0, 'teammates are not adversaries');
  const t = wa.teammates(); t[0].pos[0] = 99;
  ok(eq(g.explorer('explorer2').pos, [4, 1]), 'teammates() hands out copies');
  // move into a teammate: A at (1,1) walks to (3,3)->(3,1)? build adjacency
  const g2 = build({ map: ['#########', '#@......#', '#########', '#########', '#########'], numAdversaries: 0, explorers: [[2, 1]] }).game;
  ok(!g2.legalMoves('explorer').includes('right') && g2.legalMoves('explorer2').includes('left') === false && g2.legalMoves('explorer2').includes('right'), 'a teammate\'s cell is not a legal move (both ways)');
  const before = g2.explorer('explorer').steps;
  const r = g2.applyMove('right', 1, 'explorer');
  ok(!r.moved && g2.explorer('explorer').steps === before && eq(g2.pos, [1, 1]), 'applyMove into a teammate is a no-op');
  const dash = g2.applyMove('right', 4, 'explorer2');
  ok(dash.moved && eq(g2.explorer('explorer2').pos, [6, 1]) && eq(g2.pos, [1, 1]), 'a dash by the other explorer is unaffected');
  g2.explorer('explorer2').pos = [3, 1]; g2.explorer('explorer2').pos = [3, 1];
  const d = g2.applyMove('right', 4, 'explorer');
  ok(d.moved && eq(g2.pos, [2, 1]), 'a dash stops before a teammate');
  ok(g2.availableMoves('explorer').includes('stay') && !g2.availableMoves('explorer').includes('right'), 'availableMoves: stay yes, teammate cell no');
  // BFS blocking in a 1-wide corridor
  const g3 = build({ map: ['###########', '#@........#', '###########', '###########', '###########'], numAdversaries: 0, explorers: [[3, 1]] }).game;
  const w3 = new KnownWorld(g3, 'explorer');
  const reach = knownDistances(w3, w3.pos);
  ok(reach.has([2, 1]) && !reach.has([3, 1]) && !reach.has([5, 1]), 'known-floor BFS stops at a teammate in a 1-wide corridor');
  const w3b = new KnownWorld(g3, 'explorer2');
  ok(knownDistances(w3b, w3b.pos).has([8, 1]) && !knownDistances(w3b, w3b.pos).has([1, 1]), 'and for the other side');
  g3.explorer('explorer2').status = 'dead';
  ok(knownDistances(w3, w3.pos).has([8, 1]) && w3.teammates().length === 0, 'a dead teammate no longer blocks and is not listed');
  // situation group
  const sit = situation(wa);
  ok(sit.surroundings.teammates?.[0]?.id === 'explorer2' && sit.surroundings.teammates[0].direction === 'east' && Number.isInteger(sit.surroundings.teammates[0].distance), 'surroundings.teammates: id, direction, distance');
  ok(sit.threats.visible.length === 0 && !JSON.stringify(sit.threats).includes('explorer2'), 'teammates never appear in threats');
}

// 4. Requests: both explorers' requests carry the group and the rules sentence; bytes measured.
{
  const lines = [];
  const asks = { explorer: [], explorer2: [] };
  const run = build({ map: corridor(), numAdversaries: 0, explorers: [[12, 1]] }, { askFor: (id) => async (q) => { asks[id].push(q.state); return answer(q); } });
  const lone = build({ map: corridor(), numAdversaries: 0 }, { ask: async (q) => { lines.push(q.state); return answer(q); } });
  Math.random = seededRandom();
  for (let i = 0; i < 4; i++) { await run.playTurn(); await lone.playTurn(); }
  ok(asks.explorer.length > 0 && asks.explorer2.length > 0, 'two: both brains asked');
  const all = [...asks.explorer, ...asks.explorer2];
  ok(all.every((s) => Array.isArray(s.surroundings.teammates) && s.surroundings.teammates.length === 1 && /teammates on your side/.test(s.game)), 'two: every request has surroundings.teammates and the rules sentence');
  ok(asks.explorer[0].surroundings.teammates[0].id === 'explorer2' && asks.explorer2[0].surroundings.teammates[0].id === 'explorer', 'two: each names the other');
  ok(lines.length > 0 && lines.every((s) => !('teammates' in s.surroundings) && !/teammates/.test(s.game)), 'single: no teammates group, no rules sentence');
  ok(JSON.stringify(all).indexOf('"threats":{"visible":[],"remembered":[],"encounter":null}') >= 0 && all.every((s) => s.threats.visible.length === 0), 'two: threats stay empty');
  const group = JSON.stringify(asks.explorer[0].surroundings.teammates).length + ' "teammates":'.length;
  const sentence = asks.explorer[0].game.length - lines[0].game.length;
  console.log(`teammates group: ${group} bytes in surroundings, ${sentence} bytes in the rules sentence, ${group + sentence} bytes per request with one teammate`);
  ok(group + sentence < 400, 'teammates cost under 400 bytes per request');
  ok(run.game.explorers.every((e) => e.steps === 4), 'two: Run.playTurn plays both explorers once per tick');
}

// 5. First applied pickup wins; coins are personal.
{
  const g = build({ map: ['#########', '#@.c....#', '#########', '#########', '#########'], numAdversaries: 0, explorers: [[6, 1]] }).game;
  ok(g.coinPiles.length === 1, 'coin in the arena');
  g.applyMove('right', 1, 'explorer'); // (2,1)
  g.applyMove('left', 1, 'explorer2'); // (5,1)
  ok(g.explorer('explorer').coins === 0, 'precondition');
  const r1 = g.applyMove('right', 1, 'explorer'); // onto the coin at (3,1)
  ok(r1.coins === 1 && g.explorer('explorer').coins === 1 && g.explorer('explorer2').coins === 0 && g.coinPiles.length === 0, 'the explorer who steps first takes the coin');
  const r2 = g.applyMove('left', 1, 'explorer2');
  const r3 = g.applyMove('left', 1, 'explorer2');
  ok(!r2.coins && !r3.coins && g.explorer('explorer2').coins === 0, 'the other finds nothing');
}

// 6. Monsters: sight, strikes, grace, death, bumps against several explorers.
{
  const mkGame = () => {
    const run = build({ map: corridor(30), numAdversaries: 0, explorers: [[12, 1]] });
    const g = run.game;
    return g;
  };
  const g = mkGame();
  const ghost = new Adversary({ id: 'a1', pos: [14, 1] });
  g.adversaries = [ghost];
  ok(seesExplorer(g, ghost, 'explorer2') && !seesExplorer(g, ghost, 'explorer') && seesExplorer(g, ghost), 'sight is per explorer; the default is any explorer');
  ok(visibleAdversaries(g, 'explorer2').length === 1 && visibleAdversaries(g, 'explorer').length === 0 && visibleAdversaries(g).length === 0, 'visibleAdversaries(game, id)');
  const wa = new KnownWorld(g, 'explorer'), wb = new KnownWorld(g, 'explorer2');
  ok(wa.visibleAdversaries().length === 0 && wb.visibleAdversaries().map((v) => v.id).join() === 'a1' && wb.visibleAdversaries()[0].hp === ghost.hp, 'KnownWorld sees only its own sightings (a teammate\'s sighting is not shared)');
  ok(g.targetExplorer(ghost.pos).id === 'explorer2', 'a monster targets the nearest explorer it sees');
  // a claw on B hurts B, not A
  const ev = resolveAttack(g, ghost, [[12, 1]], 1, {});
  const hit = ev.find((e) => e.type === 'hit');
  ok(hit?.explorer === 'explorer2' && g.explorer('explorer2').health === g.explorer('explorer2').maxHealth - 1 && g.explorer('explorer').health === g.explorer('explorer').maxHealth, 'a claw hurts the explorer on the struck cell only (event names it)');
  ok(g.strikes.at(-1).by === 'a1', 'strike recorded');
  // explorers cannot hurt each other
  const before = g.explorer('explorer2').health;
  resolveAttack(g, EXPLORER, [[12, 1]], 5, {});
  ok(g.explorer('explorer2').health === before, 'an explorer\'s sword never hurts a teammate');
  const ev2 = resolveAttack(g, { id: 'explorer2', explorer: true }, [[13, 1]], 1, {});
  ok(ev2.every((e) => e.type !== 'hit') && g.explorer('explorer2').outcome.strikes === 0, 'explorer2 striking an empty cell');
  // death of one explorer: game continues
  g.damage(10, 'a1', 'explorer2');
  ok(g.explorer('explorer2').status === 'dead' && !g.lost && g.activeExplorers().length === 1 && g.explorer('explorer2').outcome.diedAt === 0, 'one explorer dies, the game goes on');
  ok(wa.teammates().length === 0 && g.legalMoves('explorer2').length === 0, 'a dead explorer is no teammate and has no moves');
  g.damage(10, 'a2');
  ok(g.lost && g.caughtBy === 'a2', 'the game is lost when no explorer is active');
}
{
  // grace and one hit per tick per explorer; bump with an explorer on the cell
  const g = build({ map: corridor(30), numAdversaries: 0, explorers: [[3, 1]] }).game;
  const claw = (id, pos) => new Adversary({ id, pos });
  const a1 = claw('a1', [2, 1]);
  g.adversaries = [a1];
  ok(g.explorerAt([1, 1])?.id === 'explorer' && g.explorerAt([1, 1], 'explorer') === null, 'explorerAt');
  const a2 = claw('a2', [1, 1]); // on the explorer's cell
  g.adversaries = [a2];
  const r = await stepAdversaries(g, { decide: async () => ({}) });
  ok(r.events.some((e) => e.type === 'bump' && e.id === 'a2') && g.explorer('explorer').health === g.explorer('explorer').maxHealth, 'a ghost on an explorer\'s cell is bumped, nobody loses a life');
  ok(!g.explorerAt(a2.pos), 'the ghost was knocked off');
  g.explorer('explorer2').graceTicks = 2;
  ok(graceLeft(g, 'explorer2') === 2 && graceLeft(g) === 0 && graceLeft(g, 'explorer') === 0, 'grace is per explorer');
  await stepAdversaries(g, { decide: async () => ({}) });
  ok(g.explorer('explorer2').graceTicks === 1 && g.explorer('explorer').graceTicks === 0, 'grace counts down per explorer');
}

// 7. Fog twin: hidden tiles / a hidden ghost outside the shared lit area change no request of any explorer.
{
  const make = (variant, x0 = 40) => {
    const rows = corridor(58).map((r) => r.split(''));
    // a hidden room (x 40..57, rows 2-3) whose interior differs between the twins; row 1 stays open
    for (let x = x0; x <= x0 + 17; x++) { rows[2][x] = '.'; rows[3][x] = '.'; }
    for (const x of variant ? [4, 10, 14] : [2, 7, 12]) rows[2][x0 + x] = '#';
    for (const x of variant ? [1, 8] : [5, 16]) rows[3][x0 + x] = '#';
    return { map: rows.map((r) => r.join('')), numAdversaries: 0, explorers: [[12, 1]], treasure: variant ? [57, 1] : [55, 1] };
  };
  const capture = async (variant, x0 = 40) => {
    const bodies = { explorer: [], explorer2: [] };
    const run = build(make(variant, x0), { askFor: (id) => async (q) => { bodies[id].push(JSON.stringify(q.body)); return answer(q); } });
    Math.random = seededRandom();
    for (let i = 0; i < 6; i++) await run.playTurn();
    return bodies;
  };
  const a = await capture(false), b = await capture(true);
  ok(a.explorer.length > 2 && a.explorer2.length > 2, 'twin: requests were captured');
  ok(eq(a.explorer, b.explorer), 'twin: explorer 1 requests are byte-identical');
  ok(eq(a.explorer2, b.explorer2), 'twin: explorer 2 requests are byte-identical');
  // control: the same difference inside the lit area must show up
  const c = await capture(false, 14), d = await capture(true, 14);
  ok(!eq(c.explorer2, d.explorer2), 'twin control: a difference inside the lit area does change the request');
}
// 7b. A hidden ghost moved elsewhere in the dark (Game.twin) changes nothing either.
{
  const mkRun = (ghostAt) => {
    const dir = mk();
    const cfg = { map: corridor(58), numAdversaries: 0, explorers: [[12, 1]] };
    const run = newTestGame(cfg, { ask: async (q) => answer(q), decide: async () => ({}), memoryDir: dir, dir, confidence: { fixedMood: true } });
    run.game.adversaries = [new Adversary({ id: 'a1', pos: ghostAt })];
    return run;
  };
  const cap = async (ghostAt) => {
    const out = [];
    const run = mkRun(ghostAt);
    for (const { id, brain } of run.explorers) void id, void brain;
    Math.random = seededRandom();
    const bodies = [];
    for (let i = 0; i < 3; i++) { await run.playTurn(); for (const { brain } of run.explorers) bodies.push(JSON.stringify(brain.lastRequests().map((r) => r.body ?? r))); }
    return bodies;
  };
  ok(eq(await cap([50, 1]), await cap([57, 1])), 'twin: a hidden ghost anywhere in the dark leaves every request identical');
}

// 8. Single-explorer Run keeps its shape.
{
  const run = build({ map: corridor(), numAdversaries: 0 });
  ok(run.explorers.length === 1 && run.explorers[0].brain === run.explorer, 'single: run.explorers has the one brain');
  const t = await run.playTurn();
  ok(!('explorers' in t), 'single: the turn has no explorers map');
  const t2 = await build({ map: corridor(), numAdversaries: 0, explorers: [[12, 1]] }).playTurn();
  ok(t2.explorers && Object.keys(t2.explorers).join() === 'explorer,explorer2', 'two: the turn carries both explorers\' turns');
}

rmSync(root, { recursive: true, force: true });
uninstall();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('check-explorers: all checks passed');
