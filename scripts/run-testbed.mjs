// Plays a testbed arena (src/testbed.js) in the terminal and prints how the explorer reacts each tick:
// its move, decision trigger, sentiment, tactic, and what the adversaries did.
// Default is a dry run with stub answers (free). --live calls the real Jev and COSTS MONEY.
// Run from the dungeon-game directory:
//   node scripts/run-testbed.mjs --size 9x9 --numAdversaries 2 --props few --treasure far --ticks 30
//   node scripts/run-testbed.mjs --map arena.txt --live
// Any testbed option works as --<option> <value>; --map takes a file of ASCII rows.
// Memory files go to a temp dir, so a running server's memory.json is never touched.

import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) continue;
  const name = args[i].slice(2);
  flags[name] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
}
const LIVE = flags.live === 'true';
const TICKS = Number(flags.ticks ?? 30);
const QUIET = flags.quiet === 'true';
for (const k of ['live', 'ticks', 'quiet']) delete flags[k];
if (flags.map) flags.map = readFileSync(flags.map, 'utf8');

// .env has to be loaded before the turn module pulls in jev.js (same order as server.js).
if (LIVE) {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
  if (!process.env.JEV_API_KEY) throw new Error('JEV_API_KEY is missing from .env');
  console.warn(`LIVE: real Jev calls, up to ${TICKS} ticks. Each tick bills 1-2 explorer requests plus 1 per hunting adversary, each hedged x2.`);
}
const { newTestGame, playTurn } = await import('../src/turn.js');
const { setAsker, setMemoryDir } = await import('../src/characters/explorer/brain.js');
const { setDecider, seesExplorer } = await import('../src/characters/adversary/adversary.js');
const { TestbedError } = await import('../src/testbed.js');

const dir = mkdtempSync(join(tmpdir(), 'testbed-run-'));
setMemoryDir(pathToFileURL(dir + '/'));
if (!LIVE) {
  // Stub answers: first option of every Choice (the brain shuffles options, so this is a random pick).
  const first = (q) => Object.keys(q.criteria ?? {})[0];
  const stub = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) =>
    [k, q.type === 'noul' ? { noul: 0.9 } : { choice: first(q), probabilities: { [first(q)]: 1 }, confidence: 1 }]));
  setAsker(stub);
  setDecider(stub);
}

let game, memory;
try {
  ({ game, memory } = newTestGame(flags));
} catch (err) {
  if (err instanceof TestbedError) { console.error(`Bad testbed config: ${err.message}`); process.exit(2); }
  throw err;
}

const draw = () => {
  const ghosts = new Map(game.adversaries.map((a) => [a.pos.join(), a]));
  const t = game.dungeon.treasure;
  return game.dungeon.tiles.map((row, y) => [...row].map((c, x) => {
    if (game.pos[0] === x && game.pos[1] === y) return '@';
    const g = ghosts.get(`${x},${y}`);
    if (g) return g.mode === 'patrol' ? 'a' : 'A';
    if (t && t[0] === x && t[1] === y) return 'T';
    if (c === '#' && game.dungeon.props.some((p) => p.solid && p.x === x && p.y === y)) return 'p';
    return c;
  }).join('')).join('\n');
};

const d = game.dungeon;
console.log(`Testbed ${d.width}x${d.height}, seed ${d.seed}, chest ${d.treasure ?? 'none'}, ${game.adversaries.length} adversaries, ${d.props.length} props, ${LIVE ? 'LIVE Jev' : 'dry run (stub answers)'}`);
console.log(draw());
for (let tick = 1; tick <= TICKS && !game.won && !game.lost; tick++) {
  // playTurn, not takeTurn + stepAdversaries: it also records hits in the explorer's memory, as the game does.
  const turn = await playTurn(game, memory, pathToFileURL(dir + '/'));
  const { events } = turn;
  const dec = turn.decision;
  const parts = [`#${String(turn.step).padStart(3)} ${String(turn.dir).padEnd(5)} -> ${game.pos.join(',').padEnd(5)}`];
  if (turn.forced) parts.push('forced');
  if (dec) parts.push(`DECIDE[${dec.trigger}] mood=${dec.sentiment?.choice ?? '-'} tactic=${dec.tactic?.choice ?? '-'}`);
  parts.push(`approach=${memory.approach.id} mood=${memory.sentiment.id}`);
  if (turn.review) parts.push(`review=${JSON.stringify(turn.review)}`);
  if (turn.policy) parts.push(`policy=${JSON.stringify(turn.policy)}`);
  const seen = game.adversaries.filter((a) => seesExplorer(game, a)).map((a) => `${a.id}@${a.pos}(${a.mode})`);
  if (seen.length) parts.push(`sees ${seen.join(' ')}`);
  if (events.length) parts.push(`events ${events.map((e) => `${e.id}:${e.type}`).join(' ')}`);
  parts.push(`hp=${game.health}`);
  if (LIVE) parts.push(`${turn.apiMs}ms`);
  console.log(parts.join(' | '));
  if (!QUIET && (dec || events.length)) console.log(draw());
}
console.log(`\n${game.won ? 'WON' : game.lost ? `LOST (caught by ${game.caughtBy})` : 'stopped'} after ${game.steps} steps. Memory: ${dir}`);
