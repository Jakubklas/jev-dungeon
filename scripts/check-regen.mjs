// Checks for natural healing (Game.regenerate): a hurt explorer gets REGEN_AMOUNT lives back every REGEN_STEPS steps
// (a stay counts), never above max, never once the game is over; hearts still heal a whole life, capped at max; Run.playTurn
// emits a `regen` event apart from `heart`. Free, no Jev.
import { clawDecide } from './lib/duel-harness.mjs'; // installs the fetch tripwire
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Game, STAY, configureWorld, REGEN_STEPS, REGEN_AMOUNT } from '../src/dungeon.js';
import { buildArena } from '../src/testbed.js';
import { newTestGame } from '../src/turn.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(`FAIL: ${m}`); } };

ok(REGEN_STEPS === 30 && REGEN_AMOUNT === 0.5, 'defaults: half a life every 30 steps');

const arena = (extra = {}) => new Game(buildArena({ size: [7, 7], numAdversaries: 0, ...extra }).dungeon);

// ---- 1. the clock
configureWorld({ lives: 3 });
let g = arena();
ok(g.health === 3 && g.maxHealth === 3, 'starts with 3 lives');
g.damage(2);
for (let i = 1; i < 30; i++) ok(g.applyMove(STAY).regen === 0, `no regen at step ${i}`);
let r = g.applyMove(STAY);
ok(r.regen === 0.5 && g.health === 1.5 && g.regenAt === 30, `half a life at step 30 (health ${g.health})`);
for (let i = 31; i < 60; i++) g.applyMove(STAY);
r = g.applyMove(STAY);
ok(r.regen === 0.5 && g.health === 2, 'another half at step 60');
for (let i = 61; i <= 90; i++) g.applyMove(STAY);
ok(g.health === 2.5, 'step 90: 2.5');
for (let i = 91; i <= 150; i++) g.applyMove(STAY);
ok(g.health === 3, `capped at max lives (${g.health})`);

// ---- 2. a real step counts like a stay; full lives never regen
g = arena();
ok(g.health === 3, 'fresh game at full lives');
for (let i = 1; i <= 30; i++) g.applyMove(i % 2 ? 'left' : 'right');
ok(g.steps === 30 && g.health === 3 && g.regenAt === null, 'no regen at full lives');
g.damage(1);
for (let i = 31; i <= 60; i++) r = g.applyMove(i % 2 ? 'left' : 'right');
ok(r.moved && r.regen === 0.5 && g.health === 2.5, 'moving steps regen too');

// ---- 3. a fractional life: damage, the loss, and a heart capped at max
g.damage(2);
ok(g.health === 0.5 && !g.lost, 'half a life left is still alive');
g.damage(1);
ok(g.health === 0 && g.lost, 'lost at 0');
for (let i = 0; i < 40; i++) g.applyMove(STAY);
ok(g.health === 0, 'no regen once lost');
g = arena({ hearts: [[3, 4]], start: [4, 4] });
g.damage(1); g.health = 2.5;
r = g.applyMove('left');
ok(r.healed === 0.5 && g.health === 3 && g.heartPiles.length === 0, `a heart heals up to max only (${g.health})`);

// ---- 4. configurable, and off at 0
configureWorld({ regenSteps: 10, regenAmount: 1 });
g = arena(); g.damage(2);
for (let i = 0; i < 10; i++) g.applyMove(STAY);
ok(g.health === 2, 'regenSteps 10 / regenAmount 1');
configureWorld({ regenSteps: 0 });
g = arena(); g.damage(2);
for (let i = 0; i < 90; i++) g.applyMove(STAY);
ok(g.health === 1, 'regenSteps 0 = no regen');
configureWorld({ regenSteps: 30, regenAmount: 0.5 });

// ---- 5. Run.playTurn emits `regen` (not `heart`) on the step it heals
const dir = pathToFileURL(mkdtempSync(join(tmpdir(), 'jev-regen-')) + '/');
const ask = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.type === 'noul'
  ? { noul: 0.1 } : { choice: k === 'next_move' ? 'stay' : k === 'skill' ? 'none' : Object.keys(q.criteria)[0], probabilities: {}, confidence: 1 }]));
const run = newTestGame({ size: [7, 7], numAdversaries: 0 }, { ask, decide: clawDecide, dir, memoryDir: dir });
run.game.damage(1);
let regenTurns = 0, heartEvents = 0;
for (let i = 0; i < 61; i++) {
  const t = await run.playTurn();
  regenTurns += t.events.filter((e) => e.type === 'regen').length;
  heartEvents += t.events.filter((e) => e.type === 'heart').length;
}
ok(regenTurns === 2 && heartEvents === 0, `two regen events in 61 turns, no heart event (regen ${regenTurns}, heart ${heartEvents}, steps ${run.game.steps})`);
ok(run.game.health === 3, `healed back to full through Run (${run.game.health})`);
configureWorld({ lives: 2 });

console.log(fails ? `\n${fails} check(s) failed` : 'check-regen: all checks passed');
process.exit(fails ? 1 : 0);
