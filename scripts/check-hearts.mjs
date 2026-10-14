// Checks for hearts (rare, fixed, restore a life when hurt): spawnHearts (count, rooms, own stream, nothing else moves),
// fog (KnownWorld.seenHearts lights only), the explorer's view (nothing while at full lives; hearts, move facts and the
// heal approach while hurt) and the pickup through the REAL ExplorerBrain with a stub Jev. Free, no Jev.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clawDecide } from './lib/duel-harness.mjs'; // installs the fetch tripwire
import { newGame, newTestGame } from '../src/turn.js';
import { generateDungeon, STEP_MS } from '../src/dungeon.js';
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
// ---- 4. midlow's cautious retreat also runs to a heart (brain #heartRun), through the real ExplorerBrain
{
  const seen = [];
  const ask = async ({ kind, questions }) => {
    seen.push({ kind, questions });
    const out = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') { out[k] = { noul: 0.1 }; continue; }
      const keys = Object.keys(q.criteria);
      if (k === 'sentiment') out[k] = answer(keys.includes('cautious') ? 'cautious' : keys[0]);
      else if (k === 'tactic') out[k] = answer(keys.includes('run_away') ? 'run_away' : keys[0]);
      else out[k] = answer(k === 'skill' ? 'none' : keys.filter((d) => d !== 'stay')[0] ?? 'stay');
    }
    return out;
  };
  // 3 lives, 2 left (not the last life), C pushed into midlow: cautious is offered and the retreat tactics are on the menu
  const run = newTestGame({ map: [WALL, FL, '#@' + '.'.repeat(18) + '#', FL, WALL], numAdversaries: 0, adversaries: [[7, 2]], hearts: [[1, 3]], treasure: null }, { ask, decide: clawDecide, dir, memoryDir: dir, confidence: { start: 40 } });
  run.game.maxHealth = 3; run.game.health = 2;
  await run.playTurn();
  const sent = seen.find((r) => r.questions.sentiment);
  const tac = seen.find((r) => r.questions.tactic)?.questions.tactic;
  const offered = sent ? Object.keys(sent.questions.sentiment.criteria) : [];
  ok(offered.includes('cautious'), `midlow: cautious is offered (${offered})`);
  {
    const fact = JSON.stringify(tac?.criteria?.run_away ?? '');
    ok(/seen heart/.test(fact), `cautious + hurt: run_away targets the heart (${fact.slice(0, 160)})`);
  }
}
// ---- 5. heart respawn: a heart taken while hurt comes back at its own cell HEART_RESPAWN steps later (0 = never).
// The explorer is never told: no respawn wording, and a pending respawn is hidden state (twins below).
{
  const D = await import('../src/dungeon.js');
  const { STAY, configureWorld } = D;
  const { mulberry32 } = await import('./lib/duel-harness.mjs');
  const DEFAULT_RESPAWN = D.HEART_RESPAWN;
  ok(DEFAULT_RESPAWN === 200, `respawn: default HEART_RESPAWN is 200 (${DEFAULT_RESPAWN})`);
  const regenSteps = D.REGEN_STEPS;
  configureWorld({ regenSteps: 0 }); // keep natural healing out of the health numbers below
  const hall = (hearts, extra = {}) => newTestGame({ map: MAP, numAdversaries: 0, adversaries: [], hearts, treasure: null, ...extra },
    { ask: stub().ask, decide: clawDecide, dir, memoryDir: dir });
  const { KnownWorld: KW } = await import('../src/characters/explorer/known-world.js');
  const has = (g, c) => g.heartPiles.some((h) => h[0] === c[0] && h[1] === c[1]);
  try {
    // 5.1 pickup while hurt records heartsTaken with the right due; the heart is gone from heartPiles
    configureWorld({ heartRespawn: 5 });
    {
      const g = hall([[3, 2]]).game;
      g.maxHealth = 4; // room for two heals
      ok(Array.isArray(g.heartsTaken) && g.heartsTaken.length === 0, `respawn 5.1: a new game has an empty heartsTaken (${JSON.stringify(g.heartsTaken)})`);
      g.health = 1;
      g.applyMove('right'); // step 1 -> (2,2)
      const r = g.applyMove('right'); // step 2 -> (3,2): picks the heart up
      ok(r.healed === 1 && g.health === 2, `respawn 5.1: the pickup heals (${r.healed}, ${g.health})`);
      ok(!has(g, [3, 2]) && g.heartPiles.length === 0, 'respawn 5.1: the heart left heartPiles');
      ok(JSON.stringify(g.heartsTaken) === JSON.stringify([{ cell: [3, 2], due: 7 * STEP_MS }]), `respawn 5.1: heartsTaken = [{ cell: [3,2], due: 2 + 5 }] (${JSON.stringify(g.heartsTaken)})`);
      configureWorld({ heartRespawn: 50 });
      ok(g.heartsTaken[0].due === 7 * STEP_MS, 'respawn 5.1: changing HEART_RESPAWN after the pickup leaves the due alone');
      configureWorld({ heartRespawn: 5 });

      // 5.2 it comes back exactly at due (not one step earlier), same cell, `respawned` reported; it heals again
      const seq = ['right', 'right', 'left', 'right']; // steps 3..6: (4,2) (5,2) (4,2) (5,2), never on (3,2)
      let early = 0;
      for (const d of seq) { const m = g.applyMove(d); early += m.respawned ?? 0; }
      ok(!new KW(g).seenHearts().length, 'respawn 5.2: KnownWorld does not see the pending (lit) heart before due');
      ok(g.steps === 6 && !has(g, [3, 2]) && early === 0, `respawn 5.2: not back one step early (step ${g.steps}, piles ${JSON.stringify(g.heartPiles)}, respawned ${early})`);
      const back = g.applyMove('left'); // step 7 -> (4,2)
      ok(g.steps === 7 && has(g, [3, 2]) && g.heartPiles.length === 1, `respawn 5.2: back at (3,2) at due (piles ${JSON.stringify(g.heartPiles)})`);
      ok(JSON.stringify(new KW(g).seenHearts()) === '[[3,2]]', 'respawn 5.2: KnownWorld sees it again once back (lit cell)');
      ok(back.respawned === 1, `respawn 5.2: applyMove reports respawned 1 (${back.respawned})`);
      ok(g.heartsTaken.length === 0, `respawn 5.2: the respawned entry left heartsTaken (${JSON.stringify(g.heartsTaken)})`);
      const again = g.applyMove('left'); // step 8 -> (3,2): picks it up again
      ok(again.healed === 1 && g.health === 3 && !has(g, [3, 2]), `respawn 5.2: the respawned heart heals again (${again.healed}, ${g.health})`);
      ok(JSON.stringify(g.heartsTaken) === JSON.stringify([{ cell: [3, 2], due: 13 * STEP_MS }]), `respawn 5.2: the second pickup is scheduled again (${JSON.stringify(g.heartsTaken)})`);
      ok(g.skillRand === null && g.coinRand === null, 'respawn 5.2: no rng stream was created');
    }

    // 5.3 at full health a heart is not taken, so nothing is scheduled
    {
      const g = hall([[3, 2]]).game;
      g.applyMove('right'); g.applyMove('right');
      ok(has(g, [3, 2]) && g.health === g.maxHealth && g.heartsTaken.length === 0, `respawn 5.3: full lives: heart stays, nothing scheduled (${JSON.stringify(g.heartsTaken)})`);
    }

    // 5.4 HEART_RESPAWN 0: never comes back
    configureWorld({ heartRespawn: 0 });
    {
      const g = hall([[3, 2]]).game;
      g.health = 1;
      g.applyMove('right'); g.applyMove('right');
      ok(!has(g, [3, 2]) && g.heartsTaken.length === 0, `respawn 5.4: 0 = nothing scheduled (${JSON.stringify(g.heartsTaken)})`);
      let n = 0;
      for (let i = 0; i < 300; i++) { const m = g.applyMove(i % 2 ? 'left' : 'right'); n += m.respawned ?? 0; }
      ok(g.heartPiles.length === 0 && n === 0, `respawn 5.4: 0 = never back after 300 steps (${JSON.stringify(g.heartPiles)})`);
    }

    // 5.5 the explorer standing on the cell at due: deferred (stays deferred through stays), back once it leaves
    configureWorld({ heartRespawn: 3 });
    {
      const g = hall([[3, 2]]).game;
      g.health = 1;
      g.applyMove('right'); g.applyMove('right'); // step 2 on (3,2): due 5
      ok(g.heartsTaken[0]?.due === 5 * STEP_MS, `respawn 5.5: due 5 (${JSON.stringify(g.heartsTaken)})`);
      let n = 0;
      for (let i = 0; i < 4; i++) { const m = g.applyMove(STAY); n += m.respawned ?? 0; } // steps 3..6, standing on it
      ok(g.steps === 6 && !has(g, [3, 2]) && n === 0, `respawn 5.5: deferred while the explorer stands on the cell (piles ${JSON.stringify(g.heartPiles)}, respawned ${n})`);
      ok(g.heartsTaken.length === 1 && g.health === 2, `respawn 5.5: still pending, no extra heal (${JSON.stringify(g.heartsTaken)}, health ${g.health})`);
      const off = g.applyMove('right'); // step 7 -> (4,2)
      ok(has(g, [3, 2]) && off.respawned === 1 && g.heartsTaken.length === 0, `respawn 5.5: back once the explorer leaves (piles ${JSON.stringify(g.heartPiles)}, respawned ${off.respawned})`);
      ok(g.health === 2, 'respawn 5.5: leaving does not heal');
    }
    // 5.5b a stay elsewhere also brings it back at due (the STAY path)
    {
      const g = hall([[3, 2]]).game;
      g.health = 1;
      g.applyMove('right'); g.applyMove('right'); g.applyMove('right'); // pickup at step 2 (due 5), step 3 on (4,2)
      g.applyMove(STAY); // step 4
      ok(!has(g, [3, 2]), 'respawn 5.5b: not back at step 4');
      const s = g.applyMove(STAY); // step 5
      ok(has(g, [3, 2]) && s.respawned === 1, `respawn 5.5b: a stay at due brings it back (respawned ${s.respawned})`);
    }

    // 5.6 twin safety: a twin taken before the pickup does not see the original's pickup or respawn
    {
      const g = hall([[3, 2]]).game;
      g.health = 1;
      const t = g.twin();
      const piles0 = JSON.stringify(t.heartPiles), taken0 = JSON.stringify(t.heartsTaken);
      g.applyMove('right'); g.applyMove('right'); // pickup
      ok(JSON.stringify(t.heartPiles) === piles0 && JSON.stringify(t.heartsTaken) === taken0, `respawn 5.6: twin untouched by the pickup (${JSON.stringify(t.heartPiles)} ${JSON.stringify(t.heartsTaken)})`);
      const mid = g.twin();
      const midTaken = JSON.stringify(mid.heartsTaken), midPiles = JSON.stringify(mid.heartPiles);
      g.applyMove('right'); g.applyMove('right'); g.applyMove(STAY); // steps 3..5: respawn at 5
      ok(has(g, [3, 2]), 'respawn 5.6: the original respawned');
      ok(JSON.stringify(t.heartPiles) === piles0 && JSON.stringify(t.heartsTaken) === taken0, 'respawn 5.6: twin untouched by the respawn');
      ok(JSON.stringify(mid.heartsTaken) === midTaken && JSON.stringify(mid.heartPiles) === midPiles, `respawn 5.6: a twin taken while pending keeps its pending entry (${JSON.stringify(mid.heartsTaken)})`);
    }

    // 5.7 fog: the explorer is never told. Stubbed Runs (real ExplorerBrain), Math.random seeded per run.
    const bodiesOf = async (hearts, setup, turns = 10) => {
      const bodies = [];
      const st = stub();
      const ask = async (a) => { bodies.push(a.body); return st.ask(a); };
      const real = Math.random;
      Math.random = mulberry32(0x4ea7);
      try {
        const run = newTestGame({ map: MAP, numAdversaries: 0, adversaries: [], hearts, treasure: null }, { ask, decide: clawDecide, dir, memoryDir: dir });
        run.game.health = 1;
        setup?.(run.game);
        const seen = [];
        for (let i = 0; i < turns && !run.game.won && !run.game.lost; i++) {
          await run.playTurn();
          seen.push({ step: run.game.steps, lit: new KW(run.game).seenHearts() });
        }
        return { bodies, run, seen };
      } finally { Math.random = real; }
    };
    const WORDS = /respawn|reappear|re-appear|come back|comes back|grow back|regrow|return(s)? to its|again later/i;
    configureWorld({ heartRespawn: 1000 });
    {
      // a lit heart at (6,2), so the explorer hears of hearts (hurt); twins add a pending respawn on a dark / lit cell
      const base = await bodiesOf([[6, 2]]);
      ok(base.bodies.length > 0, `respawn 5.7: the stub was asked (${base.bodies.length})`);
      ok(base.bodies.some((b) => /heart/i.test(b)), 'respawn 5.7: hearts do reach the hurt explorer (sanity)');
      const dark = await bodiesOf([[6, 2]], (g) => { ok(!g.isKnown([19, 2]), 'respawn 5.7: (19,2) is dark'); g.heartsTaken = [{ cell: [19, 2], due: 1000 * STEP_MS }]; });
      ok(dark.bodies.length === base.bodies.length && dark.bodies.every((b, i) => b === base.bodies[i]), 'respawn 5.7: a pending respawn on a dark cell leaves every request byte-identical');
      const lit = await bodiesOf([[6, 2]], (g) => { ok(g.isKnown([3, 2]), 'respawn 5.7: (3,2) is lit'); g.heartsTaken = [{ cell: [3, 2], due: 1000 * STEP_MS }]; });
      ok(lit.bodies.length === base.bodies.length && lit.bodies.every((b, i) => b === base.bodies[i]), 'respawn 5.7: a pending respawn on a lit cell is invisible before due (byte-identical requests)');
      ok(lit.seen.every((s) => !s.lit.some((c) => c[0] === 3 && c[1] === 2)), 'respawn 5.7: seenHearts() never lists the pending lit cell before due');
    }
    configureWorld({ heartRespawn: 4 });
    {
      // a real pickup and respawn through the brain: no respawn wording anywhere, and the heart is seen only once back
      const r = await bodiesOf([[6, 2]], null, 16);
      const g = r.run.game;
      ok(r.bodies.every((b) => !WORDS.test(b)), `respawn 5.7: no respawn wording in any request (${r.bodies.map((b) => b.match(WORDS)?.[0]).filter(Boolean)})`);
      ok(g.heartsTaken.length + g.heartPiles.length === 1 && r.bodies.length > 0, `respawn 5.7: one heart, picked up or back (${JSON.stringify(g.heartPiles)} ${JSON.stringify(g.heartsTaken)})`);
      const gone = r.seen.find((s) => !s.lit.length)?.step, back = r.seen.find((s) => s.step > (gone ?? Infinity) && s.lit.length)?.step;
      ok(gone !== undefined && back === gone + 4, `respawn 5.7: picked up at step ${gone}, seen again at ${back} (due ${gone + 4})`);
      ok(r.seen.some((s) => !s.lit.length), 'respawn 5.7: the brain picked the heart up');
      ok(r.seen.some((s, i) => i > 0 && !r.seen[i - 1].lit.length && s.lit.length), `respawn 5.7: the heart showed up again for the brain (${JSON.stringify(r.seen)})`);
    }

    // 5.8 determinism: no rng consumed; same seed = same dungeon, props, spawns, coins and hearts with respawn 0 vs 200
    const snap = (seed) => {
      const run = newGame(seed, { ask: stub().ask, decide: clawDecide, dir, memoryDir: dir });
      const d = run.game.dungeon;
      return JSON.stringify({ tiles: d.tiles, props: d.props, decor: d.decor, start: d.start, treasure: d.treasure,
        adv: run.game.adversaries.map((a) => [a.id, a.pos, a.kind, a.level]), coins: run.game.coinPiles, hearts: run.game.heartPiles });
    };
    for (let seed = 1; seed <= 8; seed++) {
      configureWorld({ heartRespawn: 0 });
      const a = snap(seed);
      configureWorld({ heartRespawn: 200 });
      ok(a === snap(seed), `respawn 5.8: seed ${seed}: the world is the same with respawn 0 and 200`);
    }
  } finally {
    configureWorld({ heartRespawn: DEFAULT_RESPAWN, regenSteps });
  }
}
console.log(fails ? `${fails} FAIL(S)` : 'check-hearts: ok');
process.exit(fails ? 1 : 0);
