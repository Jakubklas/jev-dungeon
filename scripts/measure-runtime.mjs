// Hosted actor latency calibration. Dry mode uses stubs and a fetch tripwire.
// --live is paid; --max-posts is a hard cap across explorer, monster and retry HTTP attempts.
// node scripts/measure-runtime.mjs --live --decisions 60 --max-posts 120 --seconds 180 --out result.json
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { newGame } from '../src/turn.js';
import { GameActor } from '../src/runtime/game-actor.js';
import { Gateway } from '../src/gateway/gateway.js';
import { MemoryRecorder } from '../src/gateway/recorder.js';
import { installTripwire } from './lib/tripwire.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1]; };
const live = args.includes('--live');
const decisions = Number(option('decisions', 60));
const maxPosts = Number(option('max-posts', 120));
const seconds = Number(option('seconds', 180));
const seed = Number(option('seed', 13));
for (const [name, value] of Object.entries({ decisions, maxPosts, seconds })) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}
if (live) {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
  if (!process.env.JEV_API_KEY) throw new Error('JEV_API_KEY is required');
}
const uninstall = live ? null : installTripwire();
const recorder = new MemoryRecorder();
let posts = 0, asks = 0, previousAsks = 0, actor;
let finish;
const done = new Promise((resolve) => { finish = resolve; });
const samples = [], failures = [];
const stub = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) =>
  [k, q.type === 'noul' ? { noul: 0.9 } : { choice: Object.keys(q.criteria)[0] }]));
const gateway = new Gateway({ serverKey: () => process.env.JEV_API_KEY, recorder,
  fetchImpl: (url, init) => {
    if (posts >= maxPosts) { finish('post_cap'); throw new Error('measurement HTTP cap reached'); }
    posts++;
    return globalThis.fetch(url, init);
  } });
const liveAsk = gateway.explorerAsker({ gameId: 'measurement', actorId: 'explorer', getKey: () => process.env.JEV_API_KEY });
const ask = async (request) => { asks++; return live ? liveAsk(request) : stub(request); };
const decide = live ? gateway.monsterDecider({ gameId: 'measurement' }) : stub;
const scratch = mkdtempSync(resolve(tmpdir(), 'jev-runtime-measure-'));
const memoryDir = pathToFileURL(scratch + '/');
const run = newGame(seed, { ask, decide, memoryDir, dir: memoryDir });
actor = new GameActor({ game: run.game, explorers: run.explorers, decideMonster: decide,
  onEvent: (record) => {
    if (record.type === 'explorer_turn') {
      const calls = asks - previousAsks;
      previousAsks = asks;
      if (calls) samples.push({ step: record.step, calls, observed_at: record.observed_at,
        completed_at: record.completed_at, applied_at: record.applied_at,
        duration_ms: record.completed_at - record.observed_at,
        period_ms: record.completed_at - record.observed_at + actor.rules.cadenceMs });
      if (samples.length >= decisions) finish('decision_target');
    } else if (record.type === 'decision_failed') failures.push({ actor: record.actor, reason: record.reason });
  },
  onKeyRejected: () => finish('key_rejected'), onServerKeyRejected: () => finish('server_key_rejected'),
  onFinished: () => finish('game_finished'), onError: (error) => { failures.push({ reason: error.name }); finish('runtime_error'); },
});
console.log(`${live ? 'PAID Jev' : 'Free stub'} measurement: ${decisions} explorer decisions, at most ${maxPosts} HTTP posts, ${seconds} seconds, seed ${seed}.`);
const timer = setTimeout(() => finish('time_cap'), seconds * 1000);
const started = Date.now();
let reason;
try { await actor.start(); reason = await done; } finally {
  clearTimeout(timer); await actor.stop(); uninstall?.(); rmSync(scratch, { recursive: true, force: true });
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
};
const periods = samples.map((s) => s.period_ms);
const result = { measured_at: new Date().toISOString(), live, seed, reason, elapsed_ms: Date.now() - started,
  decisions: samples.length, http_posts: posts, max_posts: maxPosts, cadence_ms: actor.rules.cadenceMs,
  step_ms_before: actor.rules.stepMs, period_p50_ms: percentile(periods, 0.5), period_p90_ms: percentile(periods, 0.9),
  suggested_step_ms: samples.length >= 30 ? Math.max(50, Math.min(5000, Math.round(percentile(periods, 0.5) / 10) * 10)) : null,
  samples, attempts: recorder.entries, failures };
const out = option('out', null);
if (out) { const path = resolve(out); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(result, null, 2) + '\n'); }
console.log(JSON.stringify({ ...result, samples: undefined, attempts: undefined }, null, 2));
if (live && (!samples.length || failures.length || result.suggested_step_ms === null)) process.exitCode = 1;
