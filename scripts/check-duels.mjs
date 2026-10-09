// Duel checks (PLAN-motivation P7a/P7b): the engage hold, end to end through the real ExplorerBrain and the duel
// harness (scripts/lib/duel-harness.mjs). The hold buys zero claws against a lone hunting ghost; the walk-in
// variant with the hold off takes claws (so the hold matters); the sword strikes the very tick the ghost steps
// adjacent; the hold releases after 5 ticks when the ghost does not come, and never applies to a stunned or patrolling
// ghost, or with a second ghost in sight. Sections 9-11 (PLAN-confidence-mood phase 2): the multi hold (`hold: 'multi'`)
// against 2-3 ghosts, the health-2 spot check and 4 ghosts (no hold). No Jev, no network. Run from dungeon-game: node scripts/check-duels.mjs
import { PLACEMENTS, man, openGroups, playDuel } from './lib/duel-harness.mjs';
import { multiGrid } from './measure-outnumbered.mjs';
import { configureLevels } from '../src/characters/adversary/kinds.js';
// Levels off on purpose: section 10 derives a 2-life run from a 9-life run, which assumes play does not depend on lives. With levels on,
// the explorer stops engaging once one claw would kill it (matchup), so the premise fails by design. Level play is in check-levels.mjs.
configureLevels({ levelsEnabled: false });

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.error('FAIL:', msg); } };

// Totals over the 24 placements of check-skills section 12.
async function sweep(extra) {
  const t = { n: 0, claws: 0, withClaw: 0, dispelled: 0, strikes: 0, held: 0, clawsBetween: 0, clawsBeforeStrike: 0, gaps: new Set(), runs: [] };
  for (const g of PLACEMENTS) {
    const r = await playDuel({ ghosts: [g], ...extra });
    t.n++; t.claws += r.claws; if (r.claws) t.withClaw++; t.dispelled += r.dispelled; t.strikes += r.strikes; t.held += r.held;
    t.clawsBetween += r.clawsBetween; t.clawsBeforeStrike += r.clawsBeforeStrike;
    t.gaps.add(r.firstStrikeTick === null ? null : r.firstStrikeTick - r.firstAdjacentTick);
    t.runs.push(r);
  }
  return t;
}

// 1. Hold ON: no claw in any of the 24 placements, whatever the scripted Jev would do at the holding cell, and a
// dispel for a ghost of 1 or 2 hp. A 3 hp ghost is a longer fight: engage is still offered (the claim gate below
// keeps the "at most one claw" sentence and the stakes line off it) and the hold still takes no claw.
const table = {};
for (const hp of [1, 2, 3]) {
  for (const policy of ['follow', 'walk-in']) {
    const t = await sweep({ ghostHp: hp, policy, hold: true });
    table[`hold on, ${policy}, hp ${hp}`] = t;
    check(t.claws === 0, `hold on, ${policy}, ghost hp ${hp}: no claw in all ${t.n} placements (got ${t.claws} in ${t.withClaw})`);
    check(t.dispelled === t.n, `hold on, ${policy}, ghost hp ${hp}: dispelled in all ${t.n} (got ${t.dispelled})`);
    check(t.strikes === t.n * hp, `hold on, ${policy}, ghost hp ${hp}: ${hp} strike(s) each (got ${t.strikes})`);
    check(t.held > 0, `hold on, ${policy}, ghost hp ${hp}: the brain held`);
  }
}

// 2. P7b: with the hold on, the tick after a ghost steps adjacent offers the sword and strikes, before any claw.
{
  const t = await sweep({ policy: 'follow', hold: true });
  check([...t.gaps].length === 1 && [...t.gaps][0] === 1, `the strike lands the tick after the ghost steps adjacent, in all placements (gaps ${[...t.gaps]})`);
  check(t.clawsBeforeStrike === 0 && t.clawsBetween === 0, 'no claw before the first strike or between the two');
}

// 3. Hold OFF + walk-in takes claws in at least one placement (the hold matters); hold OFF + follow is the text-only
// variant (a Jev that follows the printed facts); both stay measured, not asserted to a number.
const walkOff = await sweep({ policy: 'walk-in', hold: false });
const followOff = await sweep({ policy: 'follow', hold: false });
check(walkOff.withClaw >= 1, `hold off + walk-in takes a claw in at least one placement (got ${walkOff.withClaw} of ${walkOff.n})`);
check(walkOff.held === 0 && followOff.held === 0, 'hold off: the brain never holds');

// 4. The hold in other room shapes: a corridor and a dead end.
for (const room of ['corridor', 'deadend']) {
  const r = await playDuel({ room, policy: 'walk-in', hold: true });
  check(r.claws === 0 && r.dispelled === 1 && r.held > 0, `${room}: hold on, walk-in: no claw, dispelled, held (claws ${r.claws}, dispelled ${r.dispelled}, held ${r.held})`);
}

// 5. The hold releases after 5 consecutive ticks when the ghost does not come (a hunting ghost that never moves).
{
  const asked = [];
  const r = await playDuel({ ghosts: [[5, 3]], settings: { speed: 0 }, maxTicks: 14, onTurn: (turn) => asked.push({ held: turn.held, q: !!turn.move_decision }) });
  check(r.held === 5, `a ghost that never comes: exactly 5 hold ticks (got ${r.held})`);
  const first = r.trace.findIndex((t) => t.held);
  check(first >= 0 && r.trace.slice(first, first + 5).every((t) => t.held), 'the 5 hold ticks are consecutive');
  check(!asked[first].q && !asked[first + 4].q, 'a hold tick sends no move question');
  check(asked[first + 5] && !asked[first + 5].held && asked[first + 5].q, 'the 6th tick asks the normal move question');
  check(r.trace.slice(first + 5).every((t) => !t.held), 'the hold stays released while the explorer waits there');
}

// 6. No hold: a ghost stunned by the explorer's own strike (the target is next to it: close in), a patrolling ghost, or
// a second ghost in sight.
{
  const r = await playDuel({ policy: 'follow', hold: true });
  const i = r.trace.findIndex((t) => t.strikes > 0);
  check(i >= 0 && r.trace[i + 1] && !r.trace[i + 1].held, 'the tick after a strike (the ghost is stunned) is not a hold');
  check(r.trace[i + 1]?.dir !== 'stay', 'the explorer closes in on the stunned ghost');
  const asks = [];
  const p = await playDuel({ ghosts: [[5, 3]], ghostMode: 'patrol', settings: { chaseRange: 0 }, maxTicks: 12, onAsk: (q) => asks.push(q) });
  check(p.held === 0, `a patrolling ghost in sight: no hold (got ${p.held})`);
  check(p.trace.some((t) => man(t.ghosts[0]?.pos ?? [99, 99], t.pos) <= 3), 'setup: the patrolling ghost stayed near the explorer');
  for (const pair of [[[6, 3], [6, 5]], [[5, 3], [3, 5]], [[10, 3], [10, 5]]]) {
    const d = await playDuel({ ghosts: pair, maxTicks: 40 });
    let two = 0, heldWithTwo = 0, prev = d.start;
    for (const t of d.trace) {
      const near = prev.ghosts.filter((c) => Math.hypot(c[0] - prev.pos[0], c[1] - prev.pos[1]) <= 7).length;
      if (near >= 2) { two++; if (t.held) heldWithTwo++; }
      prev = { pos: t.pos, ghosts: t.ghosts.map((g) => g.pos) };
    }
    check(two > 0 && heldWithTwo === 0, `two ghosts in sight ${JSON.stringify(pair)}: ${two} such ticks, none held (got ${heldWithTwo})`);
  }
}

// 7. The turn shape reports it: `held` is a boolean on every turn, true on a hold tick, never with a move_decision.
{
  const shapes = [];
  const r = await playDuel({ onTurn: (turn) => shapes.push(turn) });
  check(shapes.length > 0 && shapes.every((t) => typeof t.held === 'boolean'), 'every turn has a boolean `held`');
  check(shapes.some((t) => t.held) && shapes.every((t) => !t.held || (t.move_decision === null && t.dir === 'stay')), 'a held turn is a stay with no move_decision');
  check(r.held === shapes.filter((t) => t.held).length, 'the harness counts the same held turns');
}

// 8. The claim gate and the text (P7a-A). A 3 hp ghost: engage is offered but its fact makes no "at most one claw"
// claim and the sentiment has no stakes sentence. At the holding cell, with the hold off, the engage move question
// says what stepping in costs and what staying is; the engage move questions drop the generic and the bold lines.
{
  const asks = [];
  await playDuel({ ghosts: [[5, 3]], ghostHp: 3, hold: false, maxTicks: 6, onAsk: (q) => asks.push(q) });
  const tactic = asks.find((q) => q.questions.tactic);
  check(tactic?.questions.tactic.criteria.engage && /3 strikes dispel it\./.test(tactic.questions.tactic.criteria.engage), `3 hp ghost: engage is offered with its strike count (${tactic?.questions.tactic.criteria.engage})`);
  check(!/at most one claw/.test(tactic?.questions.tactic.criteria.engage ?? ''), '3 hp ghost: no "at most one claw" claim');
  check(!asks.some((q) => q.questions.sentiment && /A lone adversary you can strike first/.test(q.questions.sentiment.instructions)), '3 hp ghost: no stakes sentence (not a loneFight)');
}
{
  const asks = [];
  await playDuel({ ghosts: [[5, 3]], hold: false, maxTicks: 6, onAsk: (q) => asks.push(q) });
  const spec = asks.find((q) => q.questions.move_if_engage)?.questions.move_if_engage;
  check(spec && /Steps next to it: it can claw before you strike\./.test(spec.criteria.right), `engage: the step that ends next to a hunting ghost says so (${spec?.criteria.right})`);
  check(spec && !/Steps next to/.test(`${spec.criteria.up} ${spec.criteria.down} ${spec.criteria.left}`), 'engage: the other steps do not');
  check(spec && /Holds this cell/.test(spec.criteria.stay) && /strike first/.test(spec.criteria.stay), `engage: staying at the holding cell reads as the plan (${spec?.criteria.stay})`);
  check(spec && !/moving toward|is fine/i.test(JSON.stringify(spec.instructions)), `engage move question: no "moving toward an adversary is fine" (${JSON.stringify(spec?.instructions.priorities)})`);
  const ordinary = asks.filter((q) => q.questions.next_move && q.state.plan.approach.id === 'engage');
  check(ordinary.length > 0, 'setup: an ordinary engage tick was asked (hold off)');
  for (const q of ordinary) {
    const text = JSON.stringify(q.questions.next_move.instructions);
    check(!/Stay makes no progress|new cells|moving toward|is fine/.test(text), `ordinary engage move question drops the generic lines (${text})`);
  }
}

// 9. PLAN-confidence-mood phase 2: hold: 'multi'. The walk-in Jev (the worst case: it steps toward the nearest ghost
// whatever the facts say) against 2-3 hunting ghosts, ghost hp 1-3, default settings, the open room and the 1-wide
// corridor, offsets 0..6 (open) / 1..5 (corridor), every `stride`-th open placement. Health 9, so a run is never cut
// short; death at L lives = hits >= L. With 'multi' no run takes 2 hits (death at 2 lives) and every ghost is dispelled;
// today's hold (true) takes 2+ hits against 3 ghosts, so the multi hold is what matters.
const STRIDE = 3;
const multi = await multiGrid({ hold: 'multi', stride: STRIDE });
for (const r of multi) {
  const tag = `multi hold, walk-in, ${r.count} ghosts, hp ${r.hp} (${r.runs} runs)`;
  check(r.d2 === 0, `${tag}: no run with 2 or more hits (got ${r.d2}, max claws ${r.maxClaws})`);
  check(r.notCleared === 0, `${tag}: every ghost dispelled in every run (got ${r.notCleared} runs short)`);
  check(r.held > 0, `${tag}: the brain held`);
}
const today = await multiGrid({ hold: true, counts: [3], hps: [2, 3], stride: STRIDE });
for (const r of today) {
  check(r.d2 > 0, `today's hold, walk-in, 3 ghosts, hp ${r.hp}: some run takes 2 or more hits (got ${r.d2} of ${r.runs}); else the grid proves nothing`);
  const m = multi.find((x) => x.count === 3 && x.hp === r.hp);
  check(m.d2 < r.d2 && m.claws < r.claws, `3 ghosts, hp ${r.hp}: the multi hold takes fewer claws (${m.claws} vs ${r.claws}) and deaths (${m.d2} vs ${r.d2}) than today's hold`);
}
{
  // The hold mode only matters with 2+ ghosts: one ghost plays the same under true and 'multi'.
  const a = await playDuel({ ghostHp: 2, policy: 'walk-in', hold: true });
  const b = await playDuel({ ghostHp: 2, policy: 'walk-in', hold: 'multi' });
  check(JSON.stringify(a.trace) === JSON.stringify(b.trace), "one ghost: hold true and 'multi' play the identical duel");
  // The stay fact: today's text for one ghost, "the nearest" with several.
  const one = [], two = [];
  await playDuel({ ghosts: [[5, 3]], settings: { speed: 0 }, hold: 'multi', maxTicks: 9, onAsk: (q) => one.push(q) });
  await playDuel({ ghosts: [[5, 3], [5, 5]], settings: { speed: 0 }, hold: 'multi', maxTicks: 9, onAsk: (q) => two.push(q) });
  const stay = (qs) => qs.map((q) => q.questions.move_if_engage?.criteria?.stay ?? q.questions.next_move?.criteria?.stay).find((t) => /Holds this cell/.test(t ?? ''));
  check(stay(one) === 'Holds this cell, 2 steps from it: it steps next to you and you can strike first.', `one ghost keeps today's stay fact (${stay(one)})`);
  check(/^Holds this cell, 2 steps from the nearest: /.test(stay(two) ?? ''), `two ghosts: the stay fact names the nearest (${stay(two)})`);
}

// 10. The health 2 spot check: the death derived from the health-9 runs (hits >= 2) equals the real loss when the
// explorer really has 2 lives. 20 runs of today's hold against 3 ghosts, hp 3 (where deaths happen), plus 10 multi runs.
{
  const groups = [];
  for (const n of [0, 1, 2, 3]) for (const [i, g] of openGroups(3, n, 'pairfront').entries()) if (i % 2 === 0) groups.push(g);
  let n = 0, derivedDeaths = 0;
  for (const g of groups) {
    if (n >= 20) break;
    const nine = await playDuel({ ghosts: g, ghostHp: 3, policy: 'walk-in', hold: true, health: 9, maxTicks: 90 });
    const two = await playDuel({ ghosts: g, ghostHp: 3, policy: 'walk-in', hold: true, health: 2, maxTicks: 90 });
    const derived = nine.hitsTaken >= 2;
    check(derived === two.lost, `health 2 spot check ${JSON.stringify(g)}: derived death ${derived} equals the real loss ${two.lost} (hits at health 9: ${nine.hitsTaken})`);
    check(two.hitsTaken === Math.min(2, nine.hitsTaken), `health 2 spot check ${JSON.stringify(g)}: the real hits (${two.hitsTaken}) are the first ${Math.min(2, nine.hitsTaken)} of the ${nine.hitsTaken}`);
    n++; if (derived) derivedDeaths++;
  }
  check(n === 20, `health 2 spot check: 20 runs (got ${n})`);
  check(derivedDeaths >= 1, `health 2 spot check: at least one run really dies, so the check can fail (got ${derivedDeaths})`);
  for (const g of groups.slice(0, 10)) {
    const r = await playDuel({ ghosts: g, ghostHp: 3, policy: 'walk-in', hold: 'multi', health: 2, maxTicks: 90 });
    check(!r.lost && r.dispelled === 3, `multi hold, really at 2 lives, ${JSON.stringify(g)}: alive and all dispelled (lost ${r.lost}, dispelled ${r.dispelled})`);
  }
}

// 11. Four ghosts in sight: no hold, even with 'multi'. Ticks with 4 ghosts alive and all within 7 are never held.
{
  let four = 0, heldWithFour = 0, alive3 = 0, heldWith3 = 0;
  for (const set of [[[6, 2], [6, 4], [7, 3], [8, 2]], [[5, 2], [5, 4], [8, 1], [8, 5]]]) {
    const d = await playDuel({ ghosts: set, hold: 'multi', policy: 'walk-in', maxTicks: 40 });
    let prev = d.start;
    for (const t of d.trace) {
      const near = prev.ghosts.filter((c) => Math.hypot(c[0] - prev.pos[0], c[1] - prev.pos[1]) <= 7).length;
      if (prev.ghosts.length >= 4 && near >= 4) { four++; if (t.held) heldWithFour++; }
      if (near === 3) { alive3++; if (t.held) heldWith3++; }
      prev = { pos: t.pos, ghosts: t.ghosts.map((g) => g.pos) };
    }
  }
  check(four > 0 && heldWithFour === 0, `4 ghosts in sight: ${four} such ticks, none held (got ${heldWithFour})`);
  check(alive3 > 0, `setup: ticks with exactly 3 in sight happen once a ghost is dispelled (${alive3}, ${heldWith3} held)`);
}

console.log('multi hold, walk-in (runs / claws / max claws / runs with >=2 hits / >=3 hits / runs with >=4 hits):');
for (const r of multi) console.log(`  ${r.count} ghosts, hp ${r.hp}: ${r.runs} / ${r.claws} / ${r.maxClaws} / ${r.d2} / ${r.d3} / ${r.d4}`);
for (const r of today) console.log(`  today's hold, 3 ghosts, hp ${r.hp}: ${r.runs} / ${r.claws} / ${r.maxClaws} / ${r.d2} / ${r.d3} / ${r.d4}`);

console.log('hold on, 24 placements (claws / dispelled / strikes / held ticks):');
for (const [k, t] of Object.entries(table)) console.log(`  ${k}: ${t.claws} / ${t.dispelled} / ${t.strikes} / ${t.held}`);
console.log(`  hold off, walk-in, hp 2: ${walkOff.claws} claws in ${walkOff.withClaw} of ${walkOff.n} placements, dispelled ${walkOff.dispelled}`);
console.log(`  hold off, follow, hp 2: ${followOff.claws} claws in ${followOff.withClaw} of ${followOff.n} placements, dispelled ${followOff.dispelled}`);

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('check-duels: all checks passed');
