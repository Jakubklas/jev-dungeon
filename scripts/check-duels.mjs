// Duel checks (PLAN-motivation P7a/P7b): the engage hold, end to end through the real ExplorerBrain and the duel
// harness (scripts/lib/duel-harness.mjs). The hold buys zero claws against a lone hunting ghost; the walk-in
// variant with the hold off takes claws (so the hold matters); the sword strikes the very tick the ghost steps
// adjacent; the hold releases after 5 ticks when the ghost does not come, and never applies to a stunned or patrolling
// ghost, or with a second ghost in sight. No Jev, no network. Run from dungeon-game: node scripts/check-duels.mjs
import { PLACEMENTS, man, playDuel } from './lib/duel-harness.mjs';

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

console.log('hold on, 24 placements (claws / dispelled / strikes / held ticks):');
for (const [k, t] of Object.entries(table)) console.log(`  ${k}: ${t.claws} / ${t.dispelled} / ${t.strikes} / ${t.held}`);
console.log(`  hold off, walk-in, hp 2: ${walkOff.claws} claws in ${walkOff.withClaw} of ${walkOff.n} placements, dispelled ${walkOff.dispelled}`);
console.log(`  hold off, follow, hp 2: ${followOff.claws} claws in ${followOff.withClaw} of ${followOff.n} placements, dispelled ${followOff.dispelled}`);

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('check-duels: all checks passed');
