// Checks for hearts (rare, fixed, restore a life when hurt): spawnHearts (count, rooms, own stream, nothing else moves),
// fog (KnownWorld.seenHearts lights only), the explorer's view (nothing while at full lives; hearts, move facts and the
// heal approach while hurt) and the pickup through the REAL ExplorerBrain with a stub Jev. Free, no Jev.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clawDecide } from './lib/duel-harness.mjs'; // installs the fetch tripwire
import { newGame, newTestGame } from '../src/turn.js';
import { generateDungeon } from '../src/dungeon.js';
import { spawnCoins } from '../src/coins.js';
import { spawnHearts, configureHearts, MAX_HEARTS } from '../src/hearts.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(`FAIL: ${m}`); } };
const dir = pathToFileURL(mkdtempSync(join(tmpdir(), 'jev-hearts-')) + '/');
const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });
function stub() {
  const seen = [];
  const ask = async ({ kind, state, questions }) => {
    seen.push({ kind, state, questions });
    const out = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') { out[k] = { noul: 0.1 }; continue; }
      const keys = Object.keys(q.criteria);
      if (k === 'sentiment') out[k] = answer('steady');
      else if (k === 'next_move' || k.startsWith('move_if_')) {
        // follow the approach: the option whose target part says closer, else the first non-stay
        const closer = keys.find((d) => /Picks up a heart|Closer to the target|Toward a seen heart/.test(q.criteria[d]?.text ?? q.criteria[d]?.description ?? JSON.stringify(q.criteria[d])));
        out[k] = answer(closer ?? keys.filter((d) => d !== 'stay')[0] ?? 'stay');
      } else out[k] = answer(k === 'skill' ? 'none' : keys[0]);
    }
    return out;
  };
  return { ask, seen };
}

// ---- 1. spawnHearts over generated dungeons
for (let seed = 1; seed <= 20; seed++) {
  const base = generateDungeon(seed);
  const withCoins = { ...base, coins: spawnCoins(base) };
  const h = spawnHearts(withCoins);
  ok(h.length >= 1 && h.length <= MAX_HEARTS, `seed ${seed}: ${h.length} hearts`);
  ok(h.length <= Math.max(1, Math.round(base.rooms.length / 4)), `seed ${seed}: rare (${h.length} for ${base.rooms.length} rooms)`);
  ok(JSON.stringify(h) === JSON.stringify(spawnHearts(withCoins)), `seed ${seed}: deterministic`);
  const cells = new Set(h.map(String));
  ok(cells.size === h.length, `seed ${seed}: one heart per cell`);
  ok(h.every((c) => base.tiles[c[1]][c[0]] === '.' && String(c) !== String(base.start) && String(c) !== String(base.treasure)), `seed ${seed}: floor, not start or portal`);
  const a = newGame(seed, { ask: stub().ask, decide: clawDecide, dir, memoryDir: dir });
  ok(a.game.heartPiles.length === h.length, `seed ${seed}: newGame carries the hearts`);
  const b = generateDungeon(seed);
  ok(JSON.stringify(b.tiles) === JSON.stringify(base.tiles) && JSON.stringify(spawnCoins(b)) === JSON.stringify(withCoins.coins), `seed ${seed}: dungeon and coins unchanged`);
}
configureHearts({ maxHearts: 0 });
ok(spawnHearts({ ...generateDungeon(3), coins: [] }).length === 0, 'maxHearts 0 = none');
configureHearts({ maxHearts: 6 });

// ---- 2. the explorer's view in a hall: start (1,2), a lit heart at x=6, a dark one at x=19
const FL = '#' + '.'.repeat(19) + '#', WALL = '#'.repeat(21);
const MAP = [WALL, FL, '#@' + '.'.repeat(18) + '#', FL, WALL];
const config = { map: MAP, numAdversaries: 0, adversaries: [], hearts: [[6, 2], [19, 2]], treasure: null };
{
  const st = stub();
  const run = newTestGame(config, { ask: st.ask, decide: clawDecide, dir, memoryDir: dir });
  const w = run.explorer.world ?? null;
  const known = run.game.heartPiles.filter((c) => run.game.isKnown(c));
  ok(known.length === 1 && known[0][0] === 6, `only the lit heart is known (${JSON.stringify(known)})`);
  await run.playTurn();
  const req = JSON.stringify(st.seen.map((r) => r.state));
  ok(!/heart/i.test(req), 'full lives: no heart in any request');
  ok(run.game.health === run.game.maxHealth, 'full lives at the start');
}
{
  const st = stub();
  const run = newTestGame(config, { ask: st.ask, decide: clawDecide, dir, memoryDir: dir });
  run.game.health = 1;
  let healed = false;
  for (let i = 0; i < 12 && !healed; i++) {
    const t = await run.playTurn();
    healed = run.game.health > 1;
  }
  const first = st.seen[0].state;
  ok(first.surroundings.hearts?.length === 1 && first.surroundings.hearts[0].distance === 5, `hurt: the lit heart is listed (${JSON.stringify(first.surroundings.hearts)})`);
  ok(!JSON.stringify(st.seen.map((r) => r.state)).includes('"hearts":[{"direction":"east","distance":17'), 'the dark heart never reaches Jev');
  ok(first.plan.approach.id === 'heal', `hurt: the approach is heal (${first.plan.approach.id})`);
  ok(healed && run.game.health === 2, `stepping on the heart restored a life (${run.game.health})`);
  ok(run.game.heartPiles.length === 1, 'the heart was used up');
  const moves = JSON.stringify(st.seen.map((r) => [r.state.surroundings.moves, r.questions]));
  ok(/Toward a seen heart|Picks up a heart/.test(moves), 'a move fact names the heart');
}
{
  const st = stub();
  const run = newTestGame({ ...config, hearts: [[1, 2]] }, { ask: st.ask, decide: clawDecide, dir, memoryDir: dir });
  run.game.health = 1;
  run.game.maxHealth = 2;
  // a heart is only used up when it heals: at full lives stepping on it keeps it
  run.game.health = 2;
  const g = run.game;
  g.pos = [2, 2]; g.applyMove('left');
  ok(g.heartPiles.length === 1 && g.health === 2, 'at full lives a heart stays on the floor');
}
// ---- 3. run_away heads for a heart in the low tier / panic (tacticFeasibility heartRun), only while hurt and when the route stays clear
{
  const { tacticFeasibility } = await import('../src/characters/explorer/perception.js');
  const { KnownWorld } = await import('../src/characters/explorer/known-world.js');
  const mk = (extra = {}) => newTestGame({ map: [WALL, FL, '#@' + '.'.repeat(18) + '#', FL, WALL], numAdversaries: 0, adversaries: [[7, 2]], hearts: [[1, 3]], treasure: null, ...extra }, { ask: stub().ask, decide: clawDecide, dir, memoryDir: dir });
  const run = mk();
  const world = new KnownWorld(run.game);
  run.game.health = 1;
  const plain = tacticFeasibility(world, 3, { heartRun: false });
  const heart = tacticFeasibility(world, 3, { heartRun: true });
  ok(plain.run_away && !/heart/.test(plain.run_away.fact), 'without heartRun run_away is the usual escape');
  ok(heart.run_away && /seen heart/.test(heart.run_away.fact) && heart.run_away.target.cell.join() === '1,3', `with heartRun run_away targets the heart (${heart.run_away?.fact})`);
  run.game.health = run.game.maxHealth;
  ok(!/heart/.test(tacticFeasibility(world, 3, { heartRun: true }).run_away.fact), 'at full lives no heart run');
}
console.log(fails ? `${fails} FAIL(S)` : 'check-hearts: ok');
process.exit(fails ? 1 : 0);
