// Request-hash baseline: sha256 of every explorer request body (kinds 'sentiment' and 'tick') over a fixed list
// of scenarios, so a change that must not alter what Jev reads can be proved byte-identical. Library plus CLI.
//   node scripts/request-hashes.mjs --write     recompute and write scripts/fixtures/request-hashes.json
//   node scripts/request-hashes.mjs             print a one-line summary per scenario (no write)
// Used by scripts/check-request-hashes.mjs. Scenarios: (a) every fixture in scripts/arenas/*.json for 60 ticks with
// the measure-memory stub ('first': the first option of every question, which never fights) and with a fighting
// executor, (b) generated dungeons, (c) hand-picked testbed brain scenarios (moods, tactics, props, coins,
// characters, skills off, lives). Math.random (the option shuffle) is a seeded PRNG per scenario and fetch is a
// throwing tripwire, so a scenario is reproducible and free.
// Each request is hashed twice: `h` over the JSON with keys sorted (the contract) and `r` over the body as sent
// (key order kept: the option order of every question is part of the request). `p` holds short hashes of the
// depth-2 parts (state.self, questions.next_move, ...) so a mismatch can name the first differing key path.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

globalThis.fetch = () => { throw new Error('network call in a request-hash run'); };
const { newGame, newTestGame } = await import('../src/turn.js');
const { DIRS } = await import('../src/dungeon.js');
const { clawDecide, mulberry32, man } = await import('./lib/duel-harness.mjs');

export const FIXTURE = new URL('./fixtures/request-hashes.json', import.meta.url);
const ARENAS = new URL('./arenas/', import.meta.url);

const sha = (s) => createHash('sha256').update(s).digest('hex');
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const canon = (v) => JSON.stringify(sortKeys(v));
const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });

// Depth-2 parts: 'state.self' -> 6 hex chars; scalars at depth 1 hash on their own.
export function partsOf(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = sha(canon(v2)).slice(0, 6);
    else out[k] = sha(canon(v)).slice(0, 6);
  }
  return out;
}

export function hashRequest(req) {
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? { state: req.state, questions: req.questions });
  const parsed = JSON.parse(raw);
  return { kind: req.kind, h: sha(canon(parsed)), r: sha(raw).slice(0, 12), p: partsOf(parsed) };
}

// --- stubs ---------------------------------------------------------------------------------------
// 'first': the measure-memory stub (and the same for the ghosts).
const firstAsk = async ({ questions }) => Object.fromEntries(Object.entries(questions).map(([k, q]) => {
  const first = Object.keys(q.criteria ?? {})[0];
  return [k, q.type === 'noul' ? { noul: 0.9 } : answer(first)];
}));

// 'fight': a fixed mood, a tactic preference list, skill = first non-none key (or none), moves read from the facts,
// plus a seeded walk-in probability p (own stream). It reads the game only to find the nearest ghost for a walk-in.
function fightAsk(game, { mood = 'bold', tactics = ['engage', 'run_away'], skill = true, p = 0, seed = 1 }) {
  const own = mulberry32(seed * 104729 + 17);
  let drawn = -1, walkIn = false;
  return async ({ questions, state }) => {
    const visible = (state.threats?.visible?.length ?? 0) > 0;
    if (drawn !== game.steps) { drawn = game.steps; walkIn = visible && own() < p; }
    const out = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') { out[k] = { noul: k === 'leave_now' ? 0.1 : 0.9 }; continue; }
      const keys = Object.keys(q.criteria);
      if (k === 'sentiment') out[k] = answer(keys.includes(mood) ? mood : keys[0]);
      else if (k === 'tactic') out[k] = answer(tactics.find((t) => keys.includes(t)) ?? keys[0]);
      else if (k === 'skill') out[k] = answer(skill ? keys.find((x) => x !== 'none') ?? 'none' : 'none');
      else if (k === 'next_move' || k.startsWith('move_if_')) {
        const moves = keys.filter((d) => d !== 'stay');
        let pick = null;
        if (walkIn) {
          const near = game.adversaries.reduce((b, a) => (!b || man(a.pos, game.pos) < man(b.pos, game.pos) ? a : b), null);
          const nx = (d) => [game.pos[0] + DIRS[d][0], game.pos[1] + DIRS[d][1]];
          if (near) pick = moves.filter((d) => man(nx(d), near.pos) >= 1).sort((a, b) => man(nx(a), near.pos) - man(nx(b), near.pos))[0] ?? null;
        }
        pick ??= moves.find((d) => /Reaches the target/.test(q.criteria[d])) ?? moves.find((d) => /Closer to the target/.test(q.criteria[d])) ?? null;
        out[k] = answer(pick ?? moves[0] ?? 'stay');
      } else out[k] = answer(keys[0]);
    }
    return out;
  };
}

// --- scenarios -----------------------------------------------------------------------------------
const BRAIN = [
  { name: 'lit-chest-1ghost', config: { treasure: 'far', numAdversaries: 1, seed: 3 }, exec: { mood: 'steady' }, ticks: 40 },
  { name: 'duel-2ghosts-hp3', config: { size: '17x17', numAdversaries: 5, ghostHp: 3, seed: 5 }, exec: { mood: 'bold', p: 0.3 }, ticks: 80 },
  { name: 'props-many-wary-slip', config: { size: '15x15', props: 'many', numAdversaries: 3, seed: 7 }, exec: { mood: 'wary', tactics: ['slip_past', 'hide', 'run_away'] }, ticks: 80 },
  { name: 'hide-pref-wary', config: { size: '15x13', props: 'few', numAdversaries: 2, seed: 11 }, exec: { mood: 'wary', tactics: ['hide', 'run_away'] }, ticks: 80 },
  { name: 'race-to-exit', config: { size: '15x15', treasure: 'far', numAdversaries: 2, seed: 4 }, exec: { mood: 'steady', tactics: ['race_to_exit', 'slip_past', 'run_away'] }, ticks: 60 },
  { name: 'coins-greedy', config: { size: '17x17', coins: 8, numAdversaries: 3, ghostHp: 3, seed: 9 }, exec: { mood: 'greedy' }, ticks: 80 },
  { name: 'characters-mixed', config: { size: '17x15', characters: 'mixed', numAdversaries: 4, seed: 6 }, exec: { mood: 'steady', tactics: ['run_away'] }, ticks: 80 },
  { name: 'no-explorer-skills', config: { size: '13x13', explorerSkills: 'none', numAdversaries: 2, seed: 8 }, exec: { mood: 'steady', tactics: ['slip_past', 'run_away'] }, ticks: 60 },
  { name: 'harmless-ghosts-explore', config: { size: '17x17', ghostSkills: 'none', numAdversaries: 3, ghostHp: 4, seed: 12 }, exec: { mood: 'greedy' }, ticks: 60 },
  { name: 'three-lives-bold-walkin', config: { size: '17x17', numAdversaries: 6, seed: 13 }, exec: { mood: 'bold', p: 0.6 }, lives: 3, ticks: 100 },
  { name: 'one-life-wary', config: { size: '17x17', numAdversaries: 5, seed: 14 }, exec: { mood: 'wary', tactics: ['run_away'], p: 0.5 }, lives: 1, ticks: 60 },
  { name: 'no-skill-answers', config: { size: '17x17', numAdversaries: 4, seed: 15 }, exec: { mood: 'bold', skill: false, p: 0.4 }, ticks: 80 },
  { name: 'corridor-hidden-chest', config: { map: ['####################', '#@.................#', '##################.#', '#................T.#', '#A.................#', '####################'], seed: 2 }, exec: { mood: 'steady' }, ticks: 60 },
];

export function scenarios() {
  const list = [];
  const fixtures = readdirSync(ARENAS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  for (const name of fixtures) {
    const config = JSON.parse(readFileSync(new URL(`${name}.json`, ARENAS), 'utf8'));
    list.push({ name: `fixture:${name}:first`, config, stub: 'first', ticks: 60 });
    list.push({ name: `fixture:${name}:fight`, config, exec: { mood: 'bold', p: 0.3 }, ticks: 60 });
  }
  const moods = ['bold', 'steady', 'wary', 'greedy'];
  for (let seed = 1; seed <= 6; seed++) list.push({ name: `dungeon:${seed}`, seed, exec: { mood: moods[seed % 4], p: 0.3 }, ticks: 100 });
  for (const s of BRAIN) list.push({ name: `brain:${s.name}`, ...s });
  return list;
}

// Plays one scenario and returns its request records. `opts` are extra newGame / newTestGame options (for example
// a confidence arm); `keepBodies` keeps the parsed bodies for diffing two runs in memory.
export async function playScenario(s, opts = {}, { keepBodies = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-reqhash-'));
  const url = pathToFileURL(dir + '/');
  const real = Math.random;
  Math.random = mulberry32(0x5eed ^ [...s.name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7));
  const holder = {};
  const records = [];
  try {
    const decide = s.stub === 'first' ? firstAsk : clawDecide;
    const ask = (req) => {
      const rec = hashRequest(req);
      rec.tick = holder.game?.steps ?? 0;
      if (keepBodies) rec.body = JSON.parse(req.body);
      records.push(rec);
      return holder.ask(req);
    };
    const o = { ask, decide, dir: url, memoryDir: url, ...opts };
    const run = s.seed !== undefined && !s.config ? newGame(s.seed, o) : newTestGame(s.config, o);
    const { game } = run;
    holder.game = game;
    holder.ask = s.stub === 'first' ? firstAsk : fightAsk(game, { ...(s.exec ?? {}), seed: s.seed ?? s.config?.seed ?? 1 });
    if (s.lives) game.health = game.maxHealth = s.lives;
    let ticks = 0;
    for (; ticks < s.ticks && !game.won && !game.lost; ticks++) await run.playTurn();
    return { records, ticks, outcome: game.won ? 'won' : game.lost ? 'lost' : 'running' };
  } finally {
    Math.random = real;
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function computeAll(opts = {}) {
  const out = {};
  for (const s of scenarios()) {
    const r = await playScenario(s, opts);
    out[s.name] = { ticks: r.ticks, outcome: r.outcome, requests: r.records.map((x) => [x.tick, x.kind === 'sentiment' ? 's' : 't', x.h, x.r, x.p]) };
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = await computeAll();
  for (const [name, v] of Object.entries(data)) console.log(`${name.padEnd(36)} ticks ${String(v.ticks).padStart(3)} ${v.outcome.padEnd(8)} requests ${v.requests.length}`);
  if (process.argv.includes('--write')) {
    writeFileSync(FIXTURE, JSON.stringify({ note: 'sha256 of explorer request bodies (keys sorted); see scripts/request-hashes.mjs', scenarios: data }) + '\n');
    console.log(`wrote ${fileURLToPath(FIXTURE)}`);
  }
}
