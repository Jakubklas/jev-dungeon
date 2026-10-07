// P7c measurement (PLAN-motivation): the explorer with the engage hold against TWO hunting ghosts that start N steps
// apart, in the open room (over the 24 placements of check-skills section 12 for the first ghost) and in a 1-wide
// corridor, ghost hp 1 and 2, under default settings and two non-default sets, for the scripted Jev that follows
// the printed facts ('follow') and the one that walks into the nearest ghost ('walk-in'). Free: stub Jev and ghosts
// through scripts/lib/duel-harness.mjs (throwing fetch tripwire). One row per (set, room, policy, hp, N), summed over
// the placements. The game ends in a cleared win at the second dispel, so "second ghost still in play" is counted
// as: the run ended with fewer than 2 dispels.
//   node scripts/measure-outnumbered.mjs [--json]
import { PLACEMENTS, playDuel } from './lib/duel-harness.mjs';

export const SETS = { default: {}, 'stun 3': { stunTicks: 3 }, 'claw cd 3': { clawCooldown: 3 } };
const OPEN_FLOOR = (c) => c[0] >= 1 && c[0] <= 13 && c[1] >= 1 && c[1] <= 5;
// Open room: explorer [3,3]; the second ghost is N cells further along the row (N 0 = the cell below, or above on
// row 5). Corridor: explorer [6,2], first ghost [10,2], second N cells behind it (N 1..5, one cell each).
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
export async function measureRemembered({ sets = SETS, policies = ['follow', 'walk-in'], hps = [1, 2] } = {}) {
  const rows = [];
  for (const [setName, settings] of Object.entries(sets)) {
    for (const policy of policies) {
      for (const hp of hps) {
        const row = { set: setName, policy, hp, runs: 0, claws: 0, maxClaws: 0, withClaw: 0, hits: 0, lost: 0, notCleared: 0 };
        const add = (r) => {
          row.runs++; row.claws += r.claws; row.maxClaws = Math.max(row.maxClaws, r.claws); if (r.claws) row.withClaw++;
          row.hits += r.hitsTaken; if (r.lost) row.lost++; if (r.dispelled < 2) row.notCleared++;
        };
        for (const g of PLACEMENTS) for (const y of [1, 3, 5]) if (!(g[0] === 13 && g[1] === y)) add(await playDuel({ room: 'open', ghosts: [g, [13, y]], ghostHp: hp, settings, policy, hold: true, maxTicks: 80, health: 2 }));
        add(await playDuel({ room: 'corridor', ghosts: [[10, 2], [15, 2]], ghostHp: hp, settings, policy, hold: true, maxTicks: 80, health: 2 }));
        rows.push(row);
      }
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
