// Measures where a tick's wall time goes when the REAL Jev is called: per HTTP attempt (duration, status, request bytes,
// which question kind), per tick (explorer turn vs adversaries, number of calls, retries, sequential sentiment+tick),
// and the totals. PAID: needs --live (it plays real steps). Free otherwise (prints usage).
//   node scripts/measure-latency.mjs --live [--steps 60] [--seed N] [--games 1] [--lives 3]
// --games >1 plays that many games in this process at once, to see whether parallel games slow each other down.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true'); };
if (flag('live') !== 'true') { console.log('Needs --live (paid). See the header.'); process.exit(0); }
process.loadEnvFile(new URL('../../.env', import.meta.url));
const STEPS = Number(flag('steps', 60)), GAMES = Number(flag('games', 1)), SEED = flag('seed', null), LIVES = Number(flag('lives', 3));

const { newGame } = await import('../src/turn.js');
const { Gateway } = await import('../src/gateway/gateway.js');
const gateway = new Gateway(); // the only paid askers (dev providers); the fetch wrapper below still sees every attempt
const settings = await import('../src/settings.js').catch(() => null);

// Wrap fetch: one record per HTTP attempt to the Jev API.
const attempts = [], errors = [];
let curGame = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const t0 = performance.now();
  let status = 'err', kind = '?';
  try { const q = JSON.parse(init.body).questions ?? {}; kind = Object.keys(q).includes('sentiment') ? 'sentiment' : Object.keys(q).some((k) => k.startsWith('next_move')) && Object.keys(q).some((k) => k === 'next_move') && !('keep_hunting' in q) && !('search_approach' in q) ? 'explorer-tick' : 'adversary'; } catch {}
  try {
    const res = await realFetch(url, init);
    status = res.status;
    return res;
  } catch (e) { status = e.name === 'AbortError' || e.name === 'TimeoutError' ? 'aborted/timeout' : e.cause?.code || e.name; throw e; }
  finally { attempts.push({ game: curGame, t0, ms: performance.now() - t0, status, kind, bytes: init.body.length }); }
};

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const fmt = (a) => a.length ? `n=${a.length} avg ${Math.round(a.reduce((x, y) => x + y, 0) / a.length)} p50 ${Math.round(pct(a, .5))} p90 ${Math.round(pct(a, .9))} max ${Math.round(Math.max(...a))} ms` : 'n=0';

async function play(g) {
  const dir = pathToFileURL(mkdtempSync(join(tmpdir(), 'jev-lat-')) + '/');
  const run = newGame(SEED ? Number(SEED) + g : undefined, { dir, memoryDir: dir, ask: gateway.devAsker(), decide: gateway.devDecider() });
  const ticks = [];
  for (let i = 0; i < STEPS && !run.game.won && !run.game.lost; i++) {
    const a0 = attempts.length, t0 = performance.now();
    curGame = g;
    let t;
    try { t = await run.playTurn(); } catch (e) { errors.push(`game ${g} step ${run.game.steps}: ${String(e.message).slice(0, 120)}`); break; } // a failed call ends this game; the server would answer 502
    const wall = performance.now() - t0;
    ticks.push({ g, step: t.step, wall, apiMs: t.apiMs ?? null, decision: t.decision?.trigger ?? null, n: attempts.length - a0, from: a0, to: attempts.length });
  }
  return ticks;
}
const all = (await Promise.all(Array.from({ length: GAMES }, (_, g) => play(g)))).flat();

console.log(`\n== ${GAMES} game(s), ${all.length} ticks`);
console.log('tick wall time   :', fmt(all.map((t) => t.wall)));
console.log('explorer apiMs   :', fmt(all.filter((t) => t.apiMs).map((t) => t.apiMs)));
const dec = all.filter((t) => t.decision), non = all.filter((t) => !t.decision);
console.log('decision ticks   :', fmt(dec.map((t) => t.wall)), '| ordinary ticks:', fmt(non.map((t) => t.wall)));
for (const k of ['sentiment', 'explorer-tick', 'adversary']) console.log(`HTTP ${k.padEnd(13)}:`, fmt(attempts.filter((a) => a.kind === k && typeof a.status === 'number' && a.status < 300).map((a) => a.ms)), '(ok attempts)');
const by = {}; for (const a of attempts) by[a.status] = (by[a.status] ?? 0) + 1;
console.log('attempt statuses :', JSON.stringify(by), `(of ${attempts.length}; hedge x2 means ~2 per logical call, aborted ones are the losing copy)`);
const bytes = attempts.filter((a) => a.kind !== 'adversary').map((a) => a.bytes);
console.log('explorer req size:', `avg ${Math.round(bytes.reduce((x, y) => x + y, 0) / (bytes.length || 1))} B, max ${Math.max(0, ...bytes)} B`);
const slow = [...all].sort((a, b) => b.wall - a.wall).slice(0, 6);
console.log('\nslowest ticks:');
for (const t of slow) {
  const rows = attempts.slice(t.from, t.to).map((a) => `${a.kind}:${a.status}:${Math.round(a.ms)}ms:${a.bytes}B`);
  console.log(`  game ${t.g} step ${t.step}: ${Math.round(t.wall)} ms, decision=${t.decision}, ${t.n} attempts [${rows.join(' ')}]`);
}
if (errors.length) console.log('\nERRORS (game stopped):\n  ' + errors.join('\n  '));
process.exit(0);
