// P7c measurement (PLAN-motivation): the explorer with the engage hold against TWO hunting ghosts that start N steps
// apart, in the open room (over the 24 placements of check-skills section 12 for the first ghost) and in a 1-wide
// corridor, ghost hp 1 and 2, under default settings and two non-default sets, for the scripted Jev that follows
// the printed facts ('follow') and the one that walks into the nearest ghost ('walk-in'). Free: stub Jev and ghosts
// through scripts/lib/duel-harness.mjs (throwing fetch tripwire). One row per (set, room, policy, hp, N), summed over
// the placements. The game ends in a cleared win at the second dispel, so "second ghost still in play" is counted
// as: the run ended with fewer than 2 dispels.
//   node scripts/measure-outnumbered.mjs [--json]
import { PLACEMENTS, corridorGroup, openGroups, playDuel } from './lib/duel-harness.mjs';

export const SETS = { default: {}, 'stun 3': { stunTicks: 3 }, 'claw cd 3': { clawCooldown: 3 } };
const OPEN_FLOOR = (c) => c[0] >= 1 && c[0] <= 13 && c[1] >= 1 && c[1] <= 5;
// Open room: explorer [3,3]; the second ghost is N cells further along the row (N 0 = the cell below, or the one
// above for a ghost on row 4). Corridor: explorer [6,2], first ghost [10,2], second N cells behind it (N 1..5, one cell each).
export const CASES = {
  open: {
    room: 'open', offsets: [0, 1, 2, 3, 4, 5, 6],
    pairs: (n) => PLACEMENTS.map((g) => [g, n === 0 ? [g[0], g[1] === 4 ? 3 : g[1] + 1] : [g[0] + n, g[1]]]).filter(([, s]) => OPEN_FLOOR(s) && !(s[0] === 3 && s[1] === 3)),
  },
  corridor: { room: 'corridor', offsets: [1, 2, 3, 4, 5], pairs: (n) => [[[10, 2], [10 + n, 2]]] },
};

export async function measure({ sets = SETS, policies = ['follow', 'walk-in'], hps = [1, 2] } = {}) {
  const rows = [];
  for (const [setName, settings] of Object.entries(sets)) {
    for (const [roomName, c] of Object.entries(CASES)) {
      for (const policy of policies) {
        for (const hp of hps) {
          for (const n of c.offsets) {
            const row = { set: setName, room: roomName, policy, hp, n, runs: 0, claws: 0, maxClaws: 0, withClaw: 0, hits: 0, lost: 0, notCleared: 0, strikes: 0, held: 0 };
            for (const [a, b] of c.pairs(n)) {
              if (a[0] === b[0] && a[1] === b[1]) continue;
              const r = await playDuel({ room: c.room, ghosts: [a, b], ghostHp: hp, settings, policy, hold: true, maxTicks: 60, health: 2 });
              row.runs++; row.claws += r.claws; row.maxClaws = Math.max(row.maxClaws, r.claws); if (r.claws) row.withClaw++;
              row.hits += r.hitsTaken; if (r.lost) row.lost++; if (r.dispelled < 2) row.notCleared++; row.strikes += r.strikes; row.held += r.held;
            }
            rows.push(row);
          }
        }
      }
    }
  }
  return rows;
}

// A remembered second ghost, by proxy. The harness cannot give the brain an earlier sighting, so the worst case for a
// remembered ghost is a hunting one that kept coming: it starts out of sight (>= 9 cells, about 15+ ticks away at
// speed 0.6) while the explorer fights the first. Open room: second ghost at x 13, rows 1..5; corridor: x 15.
export async function measureRemembered({ hold = true, sets = SETS, policies = ['follow', 'walk-in'], hps = [1, 2] } = {}) {
  const rows = [];
  for (const [setName, settings] of Object.entries(sets)) {
    for (const policy of policies) {
      for (const hp of hps) {
        const row = { set: setName, policy, hp, runs: 0, claws: 0, maxClaws: 0, withClaw: 0, hits: 0, lost: 0, notCleared: 0 };
        const add = (r) => {
          row.runs++; row.claws += r.claws; row.maxClaws = Math.max(row.maxClaws, r.claws); if (r.claws) row.withClaw++;
          row.hits += r.hitsTaken; if (r.lost) row.lost++; if (r.dispelled < 2) row.notCleared++;
        };
        for (const g of PLACEMENTS) for (const y of [1, 3, 5]) if (!(g[0] === 13 && g[1] === y)) add(await playDuel({ room: 'open', ghosts: [g, [13, y]], ghostHp: hp, settings, policy, hold, maxTicks: 80, health: 2 }));
        add(await playDuel({ room: 'corridor', ghosts: [[10, 2], [15, 2]], ghostHp: hp, settings, policy, hold, maxTicks: 80, health: 2 }));
        rows.push(row);
      }
    }
  }
  return rows;
}

// PLAN-confidence-mood phase 2: the multi-ghost grid (table 3). 2 and 3 ghosts, ghost hp 1-3, the open room (offsets
// N 0..6) and the 1-wide corridor, for one scripted Jev and one hold mode. Health 9 so a run is never cut short; death at
// L lives = hits >= L. `stride` keeps every stride-th open-room placement (1 = all 24).
//   rows: { count, hp, runs, claws, maxClaws, hits, d1, d2, d3, d4, lost, notCleared }  (d2 = runs with >= 2 hits = death at 2
//   lives; with clawDamage 2 a hit costs 2 lives, so d1 is the death at 2 lives; hits / runs is the mean lives-free hit count)
const CORRIDOR_N = { 2: [1, 2, 3, 4, 5], 4: [1, 2, 3], line: [1, 2], pairfront: [1, 2, 3, 4], pincers: [1, 2, 3, 4] };
export async function multiGrid({ hold = 'multi', policy = 'walk-in', counts = [2, 3], hps = [1, 2, 3], rooms = ['open', 'corridor'], stride = 1, settings = {}, health = 9, maxTicks = 90, mood = 'bold', skills } = {}) {
  const rows = [];
  for (const count of counts) {
    for (const hp of hps) {
      const row = { count, hp, runs: 0, claws: 0, maxClaws: 0, hits: 0, d1: 0, d2: 0, d3: 0, d4: 0, lost: 0, notCleared: 0, strikes: 0, held: 0, dispelled: 0 };
      const jobs = [];
      const play = async (room, ghosts) => {
        const r = await playDuel({ room, ghosts, ghostHp: hp, settings, policy, hold, health, maxTicks, mood, ...(skills ? { skills } : {}) });
        row.runs++; row.claws += r.claws; row.maxClaws = Math.max(row.maxClaws, r.claws);
        row.hits += r.hitsTaken; if (r.hitsTaken >= 1) row.d1++; if (r.hitsTaken >= 2) row.d2++; if (r.hitsTaken >= 3) row.d3++; if (r.hitsTaken >= 4) row.d4++;
        if (r.lost) row.lost++; if (r.dispelled < count) row.notCleared++;
        row.strikes += r.strikes; row.held += r.held; row.dispelled += r.dispelled;
      };
      if (rooms.includes('open')) {
        for (const n of [0, 1, 2, 3, 4, 5, 6]) {
          for (const kind of count === 3 ? ['pairfront', 'line'] : ['pair']) {
            if (kind === 'line' && n === 0) continue;
            openGroups(count, n, kind).forEach((g, i) => { if (i % stride === 0) jobs.push(['open', g]); });
          }
        }
      }
      if (rooms.includes('corridor')) {
        for (const kind of count === 3 ? ['line', 'pairfront', 'pincers'] : ['pair']) {
          for (const n of CORRIDOR_N[count === 3 ? kind : count]) jobs.push(['corridor', corridorGroup(count, n, kind)]);
        }
      }
      for (const [room, g] of jobs.splice(0)) await play(room, g);
      rows.push(row);
    }
  }
  return rows;
}

// PLAN-confidence-mood phase 2 coverage: the cells table 3 did not measure, under the multi hold, on a sampled grid
// (`stride` placements). `node scripts/measure-outnumbered.mjs --coverage [--stride 4]` takes about 2-3 minutes.
//   hits/run is the mean number of lives lost per run at claw damage 1 (hits = lives lost); d1 / d2 are the runs that
//   die at 2 lives (d2 at damage 1, d1 at damage 2: one hit costs 2 lives).
export const COVERAGE = [
  { name: 'default (reference)', settings: {}, counts: [2, 3], policies: ['walk-in'] },
  { name: 'grace 0', settings: { graceTicks: 0 }, counts: [2, 3], policies: ['walk-in'] },
  { name: 'grace 1', settings: { graceTicks: 1 }, counts: [2, 3], policies: ['walk-in'] },
  { name: 'clawDamage 2', settings: { clawDamage: 2 }, counts: [2, 3], policies: ['walk-in'] },
  { name: '4 ghosts (no hold)', settings: {}, counts: [4], policies: ['walk-in', 'follow'] },
  { name: 'sword cooldown 2', settings: { swordCooldown: 2 }, counts: [2, 3], policies: ['walk-in', 'follow'] },
];
export async function coverage({ stride = 4, only = null } = {}) {
  const out = [];
  for (const c of COVERAGE) {
    if (only && !c.name.includes(only)) continue;
    for (const policy of c.policies) for (const r of await multiGrid({ hold: 'multi', policy, counts: c.counts, settings: c.settings, stride })) out.push({ name: c.name, policy, ...r });
  }
  return out;
}
const pad = (v, n) => String(v).padStart(n);
function printCoverage(rows) {
  console.log('multi hold; health 9 (death at L lives = hits >= L; clawDamage 2: a hit costs 2 lives)');
  console.log('setting               policy  ghosts hp  runs hits/run claws max  d1  d2  d3  d4 notCleared');
  for (const r of rows) console.log(`${r.name.padEnd(21)} ${r.policy.padEnd(7)} ${pad(r.count, 5)} ${pad(r.hp, 3)} ${pad(r.runs, 5)} ${pad((r.hits / r.runs).toFixed(2), 8)} ${pad(r.claws, 5)} ${pad(r.maxClaws, 3)} ${pad(r.d1, 3)} ${pad(r.d2, 3)} ${pad(r.d3, 3)} ${pad(r.d4, 3)} ${pad(r.notCleared, 10)}`);
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--coverage')) {
  const s = process.argv.indexOf('--stride');
  const o = process.argv.indexOf('--only');
  const rows = await coverage({ stride: s > 0 ? Number(process.argv[s + 1]) : 4, only: o > 0 ? process.argv[o + 1] : null });
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
  else {
    printCoverage(rows);
    const rem = await measureRemembered({ hold: 'multi', sets: { default: {}, 'sword cd 2': { swordCooldown: 2 } } });
    console.log('\nremembered proxy under the multi hold (second ghost starts out of sight, 9+ cells away)');
    console.log('set        policy  hp  runs claws max withClaw hits lost notCleared');
    for (const r of rem) console.log(`${r.set.padEnd(10)} ${r.policy.padEnd(7)} ${r.hp}  ${pad(r.runs, 4)} ${pad(r.claws, 5)} ${pad(r.maxClaws, 3)} ${pad(r.withClaw, 8)} ${pad(r.hits, 4)} ${pad(r.lost, 4)} ${pad(r.notCleared, 10)}`);
  }
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await measure();
  const rem = await measureRemembered();
  if (!process.argv.includes('--json')) {
    console.log('remembered proxy (second ghost starts out of sight, 9+ cells away)');
    console.log('set        policy  hp  runs claws max withClaw hits lost notCleared');
    for (const r of rem) console.log(`${r.set.padEnd(10)} ${r.policy.padEnd(7)} ${r.hp}  ${String(r.runs).padStart(4)} ${String(r.claws).padStart(5)} ${String(r.maxClaws).padStart(3)} ${String(r.withClaw).padStart(8)} ${String(r.hits).padStart(4)} ${String(r.lost).padStart(4)} ${String(r.notCleared).padStart(10)}`);
    console.log('');
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
  else {
    console.log('set        room     policy  hp  N  runs claws max withClaw hits lost notCleared');
    for (const r of rows) console.log(`${r.set.padEnd(10)} ${r.room.padEnd(8)} ${r.policy.padEnd(7)} ${r.hp}  ${r.n} ${String(r.runs).padStart(4)} ${String(r.claws).padStart(5)} ${String(r.maxClaws).padStart(3)} ${String(r.withClaw).padStart(8)} ${String(r.hits).padStart(4)} ${String(r.lost).padStart(4)} ${String(r.notCleared).padStart(10)}`);
  }
}
