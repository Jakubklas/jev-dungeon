// Checks for the player's directive in the explorer brain (PLAN-inject I1): the REAL ExplorerBrain through
// newTestGame, stub Jev, throwing fetch tripwire (the duel harness installs it). Covers the API (clamp, clear,
// getter, turn.directive), what the request carries (state.directive, the rules sentence, the first priority
// line in next_move / tactic / skill, the parked approach, no review / leave_now / coin questions), the merge
// rule (one sentiment call), expiry (approach resumes, no plan.tried row), memory validation and the size delta.
// Byte-identity without a directive is scripts/check-request-hashes.mjs. Free, no Jev.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { clawDecide, mulberry32 } from './lib/duel-harness.mjs'; // installs the fetch tripwire
import { newTestGame } from '../src/turn.js';
import { LIMITS, validateMemory } from '../src/characters/explorer/memory.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(`FAIL: ${m}`); } };
const dir = pathToFileURL(mkdtempSync(join(tmpdir(), 'jev-inject-')) + '/');
const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });

// Scripted Jev: records every request; a mood/tactic/skill as configured, the first non-stay move otherwise.
function stub({ tactic = 'run_away', skill = false, done = 0 } = {}) {
  const seen = [];
  const ask = async ({ kind, state, questions }) => {
    seen.push({ kind, state, questions });
    const out = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') { out[k] = { noul: k === 'directive_done' ? done : 0.9 }; continue; }
      const keys = Object.keys(q.criteria);
      if (k === 'sentiment') out[k] = answer('steady');
      else if (k === 'tactic') out[k] = answer(keys.includes(tactic) ? tactic : keys[0]);
      else if (k === 'skill') out[k] = answer(skill ? keys.find((x) => x !== 'none') ?? 'none' : 'none');
      else if (k === 'next_move' || k.startsWith('move_if_')) out[k] = answer(keys.filter((d) => d !== 'stay')[0] ?? 'stay');
      else out[k] = answer(keys[0]);
    }
    return out;
  };
  return { ask, seen };
}

const row = (n, f) => '#' + f.repeat(n) + '#';
const HALL = ['#'.repeat(42), row(40, '.'), '#' + '@' + '.'.repeat(39) + '#', row(40, '.'), row(40, '.'), row(40, '.'), '#'.repeat(42)];
const withGhost = (rows, x, y) => rows.map((r, j) => (j === y ? r.slice(0, x) + 'A' + r.slice(x + 1) : r));

function build(config, st) {
  const real = Math.random;
  Math.random = mulberry32(0xc0ffee);
  const run = newTestGame(config, { ask: st.ask, decide: clawDecide, dir, memoryDir: dir });
  Math.random = real;
  return run;
}
async function play(run, n) {
  const real = Math.random;
  Math.random = mulberry32(0xbeef);
  const turns = [];
  try {
    for (let t = 0; t < n && !run.game.won && !run.game.lost; t++) turns.push(await run.playTurn());
  } finally { Math.random = real; }
  return turns;
}
const tickReq = (st, from = 0) => st.seen.slice(from).filter((r) => r.kind === 'tick');

// 1. API: clamp, whitespace, control chars, empty clears, getter shape.
{
  const st = stub();
  const run = build({ map: HALL, seed: 3, numAdversaries: 0 }, st);
  const b = run.explorer;
  ok(b.directive === null, 'no directive at the start');
  ok(b.memory.directive === null, 'memory.directive starts null');
  b.setDirective('  go\n\tfor   the\u0007 coins ' + 'x'.repeat(300), { steps: 5 });
  const d = b.directive;
  ok(d && d.text.length <= LIMITS.directive && d.text.length === LIMITS.directive, `clamped to ${LIMITS.directive}: ${d?.text.length}`);
  ok(d.text.startsWith('go for the coins x'), `whitespace collapsed, control chars gone: ${d.text.slice(0, 24)}`);
  ok(d.from_step === 1 && d.until_step === 5 && d.steps_left === 5, `shape ${JSON.stringify({ ...d, text: '' })}`);
  ok(b.memory.events.at(-1).text.startsWith('Heard: go for the coins'), 'event Heard');
  validateMemory(b.memory);
  b.setDirective('   ');
  ok(b.directive === null && b.memory.directive === null, 'empty text clears');
  ok(b.memory.events.at(-1).text.startsWith('Directive ended: cleared'), `event ended: ${b.memory.events.at(-1).text}`);
  b.clearDirective('again'); // no-op
  ok(b.memory.events.filter((e) => e.text.startsWith('Directive ended')).length === 1, 'clear without a directive is a no-op');
  const bad = structuredClone(b.memory);
  bad.directive = { text: 'y'.repeat(141), from_step: 1, until_step: 3 };
  let threw = false; try { validateMemory(bad); } catch { threw = true; }
  ok(threw, 'validation rejects a 141-char directive');
  bad.directive = { text: '', from_step: 1, until_step: 3 };
  threw = false; try { validateMemory(bad); } catch { threw = true; }
  ok(threw, 'validation rejects an empty directive');
}

// 2. Requests while live, merge rule, parked approach, no review / leave_now / coin questions, expiry.
{
  const st = stub();
  const run = build({ map: HALL, seed: 3, numAdversaries: 0 }, st);
  const b = run.explorer;
  await play(run, 3);
  const plain = st.seen.length;
  const approachBefore = b.memory.approach.id;
  b.setDirective('go for the coins in the east room', { steps: 12 });
  const turns = await play(run, 12);
  ok(turns[0].directive?.steps_left === 11 && turns[0].directive.text === 'go for the coins in the east room', `turn.directive ${JSON.stringify(turns[0].directive)}`);
  const reqs = st.seen.slice(plain);
  const sent = reqs.filter((r) => r.kind === 'sentiment');
  ok(sent.length === 1, `a new directive costs ONE sentiment call (got ${sent.length})`);
  ok(sent[0].questions.sentiment.instructions.includes('directive'), 'sentiment question names the directive');
  ok(sent[0].state.directive?.text === 'go for the coins in the east room', 'sentiment state carries directive');
  for (const r of reqs) {
    ok(r.state.directive && r.state.directive.steps_left >= 1 && r.state.directive.from_step === 4, `state.directive on every request ${JSON.stringify(r.state.directive)}`);
    ok(r.state.game.includes('instruction in `directive`'), 'rules sentence');
    ok(r.state.plan.approach.id === 'directive' && r.state.plan.approach.interrupted?.id === approachBefore, 'approach shown parked');
    for (const q of ['approach_working', 'next_approach', 'leave_now']) ok(!r.questions[q], `no ${q} while live`);
    const nm = r.questions.next_move;
    if (nm) {
      const p = nm.instructions.priorities;
      ok(p[0].startsWith("Follow the player's directive: \"go for the coins in the east room\"") && p[0].includes('Never step onto an adversary'), `first priority line: ${p[0]}`);
      ok(!p.some((x) => /Avoid backtracking|reveal new cells|Steady:/.test(x)), 'mood and approach lines dropped');
      ok(!Object.values(nm.criteria).some((c) => /Closer to the target|Reaches the target/.test(c)), 'no approach-target progress in the move facts');
    }
  }
  ok(b.directive === null && b.memory.directive === null, 'expired after its steps');
  ok(b.memory.events.some((e) => e.text === 'Directive ended: ran out of steps.'), 'event Directive ended: ran out of steps');
  ok(b.memory.approach.id === approachBefore && b.memory.approach.tried.length === 0, `approach resumed (${b.memory.approach.id}), no plan.tried row`);
  ok(turns.at(-1).directive === null, 'turn.directive null after expiry');
  const n = st.seen.length;
  await play(run, 2);
  ok(st.seen.slice(n).every((r) => !r.state.directive && !r.state.game.includes('`directive`') && r.state.plan.approach.id !== 'directive'), 'requests are plain again');
}

// 3. A directive with an adversary in sight: tactic + skill questions carry it; merged under the encounter's one sentiment call.
{
  const st = stub({ skill: false });
  const run = build({ map: withGhost(HALL, 8, 3), seed: 3, adversaries: [[8, 3]], start: [1, 2] }, st);
  const b = run.explorer;
  b.setDirective('stay away from ghosts', { steps: 30 });
  await play(run, 8);
  const sent = st.seen.filter((r) => r.kind === 'sentiment');
  const firstTick = st.seen.slice(0, 2);
  ok(firstTick.length === 2 && firstTick[0].kind === 'sentiment', 'start + directive on tick 1: one sentiment call, then the tick request');
  const tac = st.seen.filter((r) => r.questions.tactic);
  ok(tac.length > 0, 'a tactic question was asked');
  for (const r of tac) {
    ok(r.questions.tactic.instructions.priorities[0].startsWith("Follow the player's directive"), 'tactic: directive first');
    ok(r.questions.tactic.instructions.priorities.length === 2, 'tactic: mood line and engage default dropped');
    const spec = Object.entries(r.questions).filter(([k]) => k.startsWith('move_if_'));
    for (const [, q] of spec) ok(q.instructions.priorities[0].startsWith("Follow the player's directive"), 'move_if: directive first');
  }
  ok(sent.length >= 1, 'sentiment asked');
  const sk = st.seen.filter((r) => r.questions.skill);
  for (const r of sk) ok(r.questions.skill.instructions.question.includes("Follow the player's directive"), 'skill question carries the directive');
  console.log(`  adversary case: ${tac.length} tactic requests, ${sk.length} skill requests`);
}

// 4. Skill question with the sword ready and a ghost adjacent.
{
  const st = stub({ skill: true });
  const run = build({ map: withGhost(HALL, 3, 2), seed: 3, adversaries: [[3, 2]], start: [2, 2] }, st);
  run.explorer.setDirective('never fight', { steps: 30 });
  await play(run, 3);
  const sk = st.seen.filter((r) => r.questions.skill);
  ok(sk.length > 0, 'a skill question was asked');
  for (const r of sk) ok(r.questions.skill.instructions.question.includes('"never fight"'), 'skill question quotes the directive');
}

// 5. Replace and clear mid-way; size delta of a 140-char directive.
{
  const st = stub();
  const run = build({ map: HALL, seed: 3, numAdversaries: 0 }, st);
  const b = run.explorer;
  await play(run, 3);
  const text = 'q'.repeat(140);
  const bytes = (r) => JSON.stringify({ model: 'jev-latest', state: r.state, questions: r.questions }).length;
  const base = st.seen.length;
  await play(run, 1);
  const plain = st.seen.slice(base).filter((r) => r.kind === 'tick').map(bytes)[0];
  b.setDirective(text, { steps: 10 });
  const mark = st.seen.length;
  await play(run, 1);
  const withD = st.seen.slice(mark);
  const sentB = withD.find((r) => r.kind === 'sentiment');
  const tickB = withD.find((r) => r.kind === 'tick');
  b.setDirective('second', { steps: 4 });
  ok(b.directive.text === 'second' && b.memory.events.some((e) => e.text === 'Directive ended: replaced by a new one.'), 'replace');
  b.clearDirective('the player cleared it');
  ok(b.directive === null && b.memory.approach.tried.length === 0, 'clear leaves no plan.tried row');
  console.log(`  size: plain tick ${plain} B, with a 140-char directive: tick ${bytes(tickB)} B (${bytes(tickB) - plain >= 0 ? '+' : ''}${bytes(tickB) - plain}), sentiment ${bytes(sentB)} B`);
}

// 6. directive_done (I4): asked on an existing request every 5 steps, never on a tactic request or a forced tick;
// above 0.5 ends the directive early and the approach resumes; below, it runs its course.
{
  const st = stub({ done: 0.2 });
  const run = build({ map: HALL, seed: 3, numAdversaries: 0 }, st);
  const b = run.explorer;
  await play(run, 2);
  const approachBefore = b.memory.approach.id;
  const mark = st.seen.length;
  b.setDirective('go east', { steps: 12 });
  await play(run, 12);
  const asked = st.seen.slice(mark).filter((r) => r.questions.directive_done);
  ok(asked.length >= 2 && asked.length <= 3, `directive_done asked every ~5 steps (${asked.length})`);
  ok(asked.every((r) => r.kind === 'tick' && !r.questions.tactic && r.questions.next_move), 'directive_done rides on an ordinary tick request');
  ok(b.memory.events.some((e) => e.text === 'Directive ended: ran out of steps.'), 'a "not done" answer lets it run its course');
  const st2 = stub({ done: 0.9 });
  const run2 = build({ map: HALL, seed: 3, numAdversaries: 0 }, st2);
  const b2 = run2.explorer;
  await play(run2, 2);
  b2.setDirective('go east', { steps: 30 });
  const turns = await play(run2, 12);
  const endAt = turns.findIndex((t) => t.directive === null);
  ok(endAt >= 4 && endAt <= 6, `ended early at the first ask (turn index ${endAt})`);
  ok(b2.memory.events.some((e) => e.text === 'Directive ended: Jev judged it done.'), 'event: Jev judged it done');
  ok(b2.memory.approach.id === approachBefore && b2.memory.approach.tried.length === 0, 'approach resumed without a plan.tried row');
  ok(st2.seen.slice(-3).every((r) => !r.questions.directive_done && !r.state.directive), 'no directive_done after it ended');
  // never beside a tactic question
  const st3 = stub({ done: 0.2 });
  const run3 = build({ map: withGhost(HALL, 8, 3), seed: 3, adversaries: [[8, 3]], start: [1, 2] }, st3);
  run3.explorer.setDirective('stay away from ghosts', { steps: 30 });
  await play(run3, 14);
  ok(st3.seen.every((r) => !(r.questions.directive_done && r.questions.tactic)), 'never on the tactic request');
}

if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
console.log('check-inject: all passed');
