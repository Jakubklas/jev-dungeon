// PLAN-confidence-mood phase 4: free measurement of confidence caps. Plays the REAL ExplorerBrain end to end (newGame dungeons
// and newTestGame crowd arenas of 3-5 hp 2-3 ghosts) against CLAWING stub ghosts, with a stub Jev that picks among the moods it
// is OFFERED (bold if offered, else steady, else wary), engages when its mood is bold or steady (run_away when wary), uses the
// first non-none skill and reads moves from the move facts, plus a seeded walk-in probability p. Three arms: off (confidence
// false), caps35 (confidence 'caps', W_PER_EXTRA 0.35) and caps50 (an arm object with wPerExtra 0.5). Free: stubs everywhere,
// fetch is a throwing tripwire (duel-harness installs it), no network.
//   node scripts/measure-caps.mjs [--seeds 30] [--ticks 150] [--p 0,0.2] [--lives 2,4] [--json]
// The parent starts one child per arm (in parallel) and prints the table and the gate:
//   caps must not raise games lost or hits per game by more than 1 SE against off (paired by game) and must raise dispels.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
const SEEDS = Number(flags.seeds ?? 30);
const TICKS = Number(flags.ticks ?? 150);
const PS = (flags.p ?? '0,0.2').split(',').map(Number);
const LIVES = (flags.lives ?? '2,4').split(',').map(Number);
const ARMS = { off: false, caps35: 'caps', caps50: { caps: true, wPerExtra: 0.5 } };

async function child(arm) {
  const { clawDecide, mulberry32, man } = await import('./lib/duel-harness.mjs'); // installs the fetch tripwire
  const { DIRS } = await import('../src/dungeon.js');
  const { newGame, newTestGame } = await import('../src/turn.js');
  const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });
  const rows = [];
  for (const kind of ['dungeon', 'crowd']) for (const p of PS) for (const lives of LIVES) for (let seed = 1; seed <= SEEDS; seed++) {
    const dir = mkdtempSync(join(tmpdir(), 'jev-caps-m-'));
    const url = pathToFileURL(dir + '/');
    const rnd = Math.random;
    Math.random = mulberry32(seed * 7919 ^ 0x9e3779b9);
    try {
      const own = mulberry32(seed * 104729 + Math.round(p * 1000));
      const holder = {};
      const bytes = { sentiment: [0, 0], tick: [0, 0] };
      let offered = 0, picked = 0, wary = 0;
      const ask = async (req) => {
        const b = bytes[req.kind]; b[0] += req.body.length; b[1]++;
        return holder.ask(req);
      };
      const opts = { ask, decide: clawDecide, dir: url, memoryDir: url, confidence: ARMS[arm] };
      const run = kind === 'dungeon' ? newGame(seed, opts)
        : newTestGame({ size: 17 + (seed % 5), seed, numAdversaries: 3 + (seed % 3), ghostHp: 2 + (seed % 2) }, opts);
      const game = run.game;
      game.health = game.maxHealth = lives;
      let drawn = -1, walkIn = false, mood = null;
      holder.ask = async ({ questions, state }) => {
        const visible = (state.threats?.visible?.length ?? 0) > 0;
        if (drawn !== game.steps) { drawn = game.steps; walkIn = visible && own() < p; }
        const out = {};
        for (const [k, q] of Object.entries(questions)) {
          if (q.type === 'noul') { out[k] = { noul: k === 'leave_now' ? 0.1 : 0.9 }; continue; }
          const keys = Object.keys(q.criteria);
          if (k === 'sentiment') { mood = keys.includes('bold') ? 'bold' : keys.includes('steady') ? 'steady' : keys[0]; out[k] = answer(mood); }
          else if (k === 'tactic') out[k] = answer((mood === 'bold' || mood === 'steady') && keys.includes('engage') ? 'engage' : keys.includes('run_away') ? 'run_away' : keys[0]);
          else if (k === 'skill') out[k] = answer(keys.find((x) => x !== 'none') ?? 'none');
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
      let hits = 0, dispels = 0, ticks = 0;
      for (; ticks < TICKS && !game.won && !game.lost; ticks++) {
        const turn = await run.playTurn();
        hits += turn.events.filter((e) => e.type === 'hit').length;
        dispels += turn.events.filter((e) => e.type === 'dispelled').length;
        if (turn.decision?.sentiment?.choice) { picked++; if (turn.decision.sentiment.choice === 'wary') wary++; }
      }
      rows.push({ kind, p, lives, seed, lost: game.lost ? 1 : 0, hits, dispels, coins: game.coins, cleared: game.winBy === 'cleared' ? 1 : 0, won: game.won ? 1 : 0, picked, wary, sB: bytes.sentiment[0], sN: bytes.sentiment[1], tB: bytes.tick[0], tN: bytes.tick[1] });
      void offered;
    } finally {
      Math.random = rnd;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  process.stdout.write(JSON.stringify(rows));
}

const arm = flags.arm;
if (arm) { await child(arm); process.exit(0); }

// ---- parent ----
const self = fileURLToPath(import.meta.url);
const t0 = Date.now();
const results = {};
await Promise.all(Object.keys(ARMS).map((a) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [self, '--arm', a, '--seeds', String(SEEDS), '--ticks', String(TICKS), '--p', PS.join(','), '--lives', LIVES.join(',')], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  c.stdout.on('data', (d) => { buf += d; });
  c.on('close', (code) => { if (code) reject(new Error(`arm ${a} exited ${code}`)); else { results[a] = JSON.parse(buf); resolve(); } });
})));
const mean = (a, f) => a.reduce((s, x) => s + f(x), 0) / a.length;
const se = (xs) => { const m = xs.reduce((s, x) => s + x, 0) / xs.length; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1) / xs.length); };
const fmt = (v, d = 2) => v.toFixed(d);
const cellRows = (a, f) => results[a].filter(f);
const table = [];
for (const kind of ['dungeon', 'crowd']) for (const p of PS) for (const lives of LIVES) {
  const f = (r) => r.kind === kind && r.p === p && r.lives === lives;
  for (const a of Object.keys(ARMS)) {
    const g = cellRows(a, f);
    const picked = g.reduce((s, r) => s + r.picked, 0);
    table.push({
      cell: `${kind} p=${p} lives=${lives}`, arm: a, n: g.length, lost: g.reduce((s, r) => s + r.lost, 0), hits: mean(g, (r) => r.hits), dispels: mean(g, (r) => r.dispels), coins: mean(g, (r) => r.coins),
      cleared: g.reduce((s, r) => s + r.cleared, 0), waryShare: picked ? g.reduce((s, r) => s + r.wary, 0) / picked : 0,
      sentB: g.reduce((s, r) => s + r.sB, 0) / Math.max(1, g.reduce((s, r) => s + r.sN, 0)), tickB: g.reduce((s, r) => s + r.tB, 0) / Math.max(1, g.reduce((s, r) => s + r.tN, 0)),
    });
  }
}
console.log('cell                         arm     n  lost  hits/g dispels/g coins/g cleared wary%  sentB  tickB');
for (const r of table) console.log(`${r.cell.padEnd(28)} ${r.arm.padEnd(7)} ${String(r.n).padStart(3)} ${String(r.lost).padStart(5)} ${fmt(r.hits).padStart(7)} ${fmt(r.dispels).padStart(8)} ${fmt(r.coins).padStart(7)} ${String(r.cleared).padStart(7)} ${fmt(100 * r.waryShare, 1).padStart(5)} ${fmt(r.sentB, 0).padStart(6)} ${fmt(r.tickB, 0).padStart(6)}`);

// Pooled, paired by game (same kind, p, lives, seed): per-arm totals and the caps - off differences with their SE.
const key = (r) => `${r.kind}|${r.p}|${r.lives}|${r.seed}`;
const byKey = (a) => new Map(results[a].map((r) => [key(r), r]));
const off = byKey('off');
console.log(`\npooled over ${results.off.length} games per arm, difference caps - off (paired by game), mean +- SE:`);
const gate = {};
for (const a of ['caps35', 'caps50']) {
  const on = byKey(a);
  const diff = (f) => [...off.keys()].map((k) => f(on.get(k)) - f(off.get(k)));
  const line = {};
  for (const [name, f] of [['lost', (r) => r.lost], ['hits', (r) => r.hits], ['dispels', (r) => r.dispels], ['coins', (r) => r.coins], ['cleared', (r) => r.cleared]]) {
    const d = diff(f);
    line[name] = { m: d.reduce((s, x) => s + x, 0) / d.length, se: se(d) };
  }
  gate[a] = line;
  const all = results[a];
  console.log(`  ${a}: lost ${fmt(line.lost.m, 3)} +- ${fmt(line.lost.se, 3)}  hits/game ${fmt(line.hits.m, 3)} +- ${fmt(line.hits.se, 3)}  dispels/game ${fmt(line.dispels.m, 3)} +- ${fmt(line.dispels.se, 3)}  coins/game ${fmt(line.coins.m, 3)} +- ${fmt(line.coins.se, 3)}  cleared ${fmt(line.cleared.m, 3)} +- ${fmt(line.cleared.se, 3)}   (totals: lost ${all.reduce((s, r) => s + r.lost, 0)} vs ${results.off.reduce((s, r) => s + r.lost, 0)}, cleared ${all.reduce((s, r) => s + r.cleared, 0)} vs ${results.off.reduce((s, r) => s + r.cleared, 0)})`);
}
for (const a of ['caps35', 'caps50']) {
  const g = gate[a];
  const okLost = g.lost.m <= g.lost.se, okHits = g.hits.m <= g.hits.se, okDisp = g.dispels.m > 0;
  console.log(`GATE ${a}: lost not raised by more than 1 SE ${okLost ? 'PASS' : 'FAIL'}; hits/game not raised by more than 1 SE ${okHits ? 'PASS' : 'FAIL'}; dispels raised ${okDisp ? 'PASS' : 'FAIL'}`);
}
console.log(`wall time ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (flags.json) console.log(JSON.stringify({ table, gate }));
