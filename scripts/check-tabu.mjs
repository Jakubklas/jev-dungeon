// Tabu lists (PLAN-tabu.md): the pure module (src/characters/shared/tabu.js), then phase 1 through the real ExplorerBrain on
// testbed arenas with stubbed Jev answers: a tactic that kept failing must be ABSENT from the next tactic menu (and from
// the moods' "Tactics it leaves here" lists), not just discouraged. Free: stub ask / decide, any network call fails.
// Run: JEV_CONFIG=none node scripts/check-tabu.mjs
globalThis.fetch = () => { throw new Error('network call in a check script'); };
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as T from '../src/characters/shared/tabu.js';
import { newTestGame } from '../src/turn.js';
import { DIRS, REGEN_STEPS, configureWorld, rng } from '../src/dungeon.js';
import { configureConfidence, confidenceSnapshot } from '../src/characters/explorer/confidence.js';
import { configureExplorerBrain, explorerBrainSnapshot } from '../src/characters/explorer/brain.js';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.error('FAIL:', msg); } };

// ---- 1. The pure module ----------------------------------------------------------------------------------------------
{
  const src = readFileSync(new URL('../src/characters/shared/tabu.js', import.meta.url), 'utf8');
  ok(!/\bimport\b/.test(src.replace(/\/\/.*$/gm, '')), 'tabu.js imports nothing');
  ok(!/Math\.random|Date\.now|performance/.test(src), 'tabu.js uses no clock and no randomness');

  const t = T.createTabu();
  ok(T.add(t, 'tactic', 'run_away', { step: 10, tenure: 5, reason: 'r' }) === true, 'a new entry reports true');
  ok(T.add(t, 'tactic', 'run_away', { step: 11, tenure: 2 }) === false, 'an entry already live reports false');
  ok(T.isTabu(t, 'tactic', 'run_away', 14) && !T.isTabu(t, 'tactic', 'run_away', 15), 'tenure counts from the step it was added (the longer end kept)');
  ok(!T.isTabu(t, 'mood', 'run_away', 12), 'levels are separate');
  T.add(t, 'tactic', 'hide', { step: 10, encounter: true });
  T.age(t, 100);
  ok(T.active(t, 'tactic', 100).join() === 'hide', 'age drops ended entries, keeps encounter ones');
  ok(T.strike(t, 'tactic', 'engage') === 1 && T.strike(t, 'tactic', 'engage') === 2 && T.strikes(t, 'tactic', 'engage') === 2, 'strikes count up');
  T.clearStrikes(t, 'tactic', 'engage');
  ok(T.strikes(t, 'tactic', 'engage') === 0, 'clearStrikes resets one attribute');
  T.strike(t, 'tactic', 'a'); T.strike(t, 'mood', 'b');
  T.clearStrikes(t, 'tactic');
  ok(T.strikes(t, 'tactic', 'a') === 0 && T.strikes(t, 'mood', 'b') === 1, 'clearStrikes(level) leaves other levels');
  T.endEncounter(t);
  ok(T.active(t, 'tactic', 100).length === 0 && T.strikes(t, 'mood', 'b') === 0, 'endEncounter drops encounter entries and every strike');

  // filterOptions: order kept, keep, min, lift order (least tenure left first, encounter last, then ids order)
  const f = T.createTabu();
  T.add(f, 'tactic', 'run_away', { step: 0, encounter: true });
  T.add(f, 'tactic', 'hide', { step: 0, tenure: 9 });
  T.add(f, 'tactic', 'engage', { step: 0, tenure: 3 });
  let r = T.filterOptions(['engage', 'run_away', 'hide', 'slip_past'], f, 'tactic', 1);
  ok(r.allowed.join() === 'slip_past' && r.removed.join() === 'engage,run_away,hide' && r.lifted.length === 0, 'removes every live entry, keeps order');
  r = T.filterOptions(['engage', 'run_away', 'hide'], f, 'tactic', 1, { min: 1 });
  ok(r.allowed.join() === 'engage' && r.lifted.join() === 'engage', 'never empty: the least tenure left comes back first');
  r = T.filterOptions(['engage', 'run_away', 'hide'], f, 'tactic', 1, { min: 2 });
  ok(r.allowed.join() === 'engage,hide' && r.lifted.join() === 'engage,hide', 'min 2 lifts the next shortest, encounter entries last');
  r = T.filterOptions(['run_away', 'slip_past'], f, 'tactic', 1, { keep: ['run_away'] });
  ok(r.allowed.join() === 'run_away,slip_past' && r.removed.length === 0, 'keep is never removed');
  r = T.filterOptions(['engage', 'slip_past'], f, 'tactic', 3);
  ok(r.allowed.join() === 'engage,slip_past', 'an ended entry filters nothing');
  const snap = T.snapshot(f, 1);
  ok(snap.tactic.length === 3 && snap.tactic.find((e) => e.attr === 'run_away').steps_left === 'encounter' && snap.tactic.find((e) => e.attr === 'engage').steps_left === 2, 'snapshot: steps left or encounter');
  ok(JSON.stringify(T.filterOptions(['a', 'b'], f, 'tactic', 1)) === JSON.stringify(T.filterOptions(['a', 'b'], f, 'tactic', 1)), 'deterministic');
}

// ---- 2. Phase 1 through the real brain --------------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'jev-tabu-check-'));
let folderN = 0;
const DEFAULTS = explorerBrainSnapshot();
const knobs = (o) => configureExplorerBrain({ ...DEFAULTS, ...o });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ctl.tactic: the tactic the stub always picks when offered (else the first). ctl.skill: 'none' | 'strike'.
// Moves follow the tactic's target ("Closer to the target"), else the first non-stay move. Monsters always step toward
// the explorer (the stub reads the game, which a check may) and claw when ctl.claw is on.
function build(config, ctl = {}) {
  Math.random = rng(1234); // the option shuffle: seeded per game, so stubs that read option order replay exactly
  const folder = join(root, String(++folderN));
  mkdirSync(folder);
  const dir = pathToFileURL(folder + '/');
  const c = { tactic: 'run_away', skill: 'none', claw: false, walkIn: false, mood: null, working: 0.9, ...ctl };
  const reqs = [];
  const ask = async ({ kind, questions, body }) => {
    reqs.push({ kind, questions, body });
    return Object.fromEntries(Object.entries(questions).map(([key, q]) => {
      if (q.type === 'noul') return [key, { noul: key === 'directive_done' ? 0.1 : key === 'approach_working' ? (typeof c.working === 'function' ? c.working() : c.working) : 0.9 }];
      const ids = Object.keys(q.criteria);
      let choice = ids[0];
      if (key === 'sentiment') choice = c.mood && ids.includes(c.mood) ? c.mood : ids.includes('steady') ? 'steady' : ids[0];
      else if (key === 'tactic') choice = ids.includes(c.tactic) ? c.tactic : ids[0];
      else if (key === 'skill') choice = c.skill === 'strike' ? ids.find((id) => id !== 'none') ?? 'none' : 'none';
      else if (key === 'next_move' || key.startsWith('move_if_')) {
        if (c.walkIn) choice = towardEnemy(run, ids) ?? ids[0];
        else choice = ids.find((id) => /Closer to the target/.test(String(q.criteria[id]))) ?? ids.find((id) => id !== 'stay') ?? ids[0];
      } else if (key === 'next_approach') choice = ids[0];
      return [key, { choice, probabilities: { [choice]: 1 }, confidence: 1 }];
    }));
  };
  const decide = async ({ id, questions }) => {
    const a = run.game.adversaries.find((x) => x.id === id);
    const out = {};
    if (questions.next_move && a) {
      const ids = Object.keys(questions.next_move.criteria);
      const best = ids.slice().sort((p, q) => dist(step(a.pos, p), run.game.pos) - dist(step(a.pos, q), run.game.pos))[0];
      out.next_move = { choice: best, probabilities: { [best]: 1 }, confidence: 1 };
    }
    if (questions.skill) {
      const ids = Object.keys(questions.skill.criteria);
      const k = c.claw ? ids.find((x) => x !== 'none') ?? 'none' : 'none';
      out.skill = { choice: k, probabilities: { [k]: 1 }, confidence: 1 };
    }
    if (questions.keep_hunting) out.keep_hunting = { noul: 0.9 };
    return out;
  };
  const run = newTestGame(config, { ask, decide, memoryDir: dir, dir, confidence: { fixedMood: true }, ...(ctl.opts ?? {}) });
  return { run, reqs, c };
}
const step = (p, d) => (DIRS[d] ? [p[0] + DIRS[d][0], p[1] + DIRS[d][1]] : p);
function towardEnemy(run, ids) {
  const e = run.game.adversaries[0];
  if (!e) return null;
  return ids.filter((d) => d !== 'stay').sort((p, q) => dist(step(run.game.pos, p), e.pos) - dist(step(run.game.pos, q), e.pos))[0];
}
const tacticMenus = (reqs) => reqs.filter((r) => r.questions.tactic).map((r) => Object.keys(r.questions.tactic.criteria));
const events = (run) => run.memory.events.map((e) => e.text);
async function play(b, ticks, until = () => false) {
  const turns = [];
  for (let i = 0; i < ticks && !b.run.game.won && !b.run.game.lost; i++) {
    const n = b.reqs.length;
    turns.push(await b.run.playTurn());
    turns.at(-1).reqs = b.reqs.slice(n); // this turn's own requests
    if (until(turns.at(-1), b)) break;
  }
  return turns;
}

// A closed room: nowhere for run_away to gain distance. The monster chases (harmless: no claw skill).
// The explorer keeps its sword (the stub never swings it), so engage is the alternative a rule-out leaves.
const ROOM = { size: [9, 7], start: [2, 4], adversaries: [[8, 4]], ghostSkills: 'none', treasure: null, seed: 3 };

// 2a. T1 / T3: always run_away in a closed room -> run_away is ruled out and absent from the next tactic menus.
{
  knobs({});
  const b = build(ROOM);
  const turns = await play(b, 60, (t) => (t.tabu?.removed ?? []).includes('run_away'));
  const at = turns.findIndex((t) => (t.tabu?.removed ?? []).includes('run_away'));
  ok(at >= 0, `2a: run_away is ruled out within 60 ticks (events: ${events(b.run).join(' | ')})`);
  if (at >= 0) {
    const t = turns[at];
    ok(t.decision?.tactic && !('run_away' in t.decision.tactic.options), `2a: the rule-out tick's tactic menu has no run_away (${Object.keys(t.decision?.tactic?.options ?? {})})`);
    ok(t.reqs.every((r) => !('run_away' in (r.questions.tactic?.criteria ?? {})) && !/"move_if_run_away"/.test(r.body)), '2a: no request that tick offers run_away or asks move_if_run_away');
    const sent = t.reqs.find((r) => r.questions.sentiment);
    ok(sent && Object.values(sent.questions.sentiment.criteria).every((c) => !/Tactics it leaves here: [^.]*run away/.test(c)), '2a: no mood lists run away in "Tactics it leaves here"');
    ok(events(b.run).some((e) => /^Ruled out run away: /.test(e)), '2a: one memory event says why');
    ok(turns[at].decision?.tactic?.choice !== 'run_away', '2a: the re-decision picks another tactic');
    ok(turns[at].tabu.tactic?.some((e) => e.attr === 'run_away'), '2a: turn.tabu lists it');
  }
}

// 2b. T3 alone (ping-pong rule switched off by a high PINGPONG_FAILS): the reason is the retreat that gained nothing.
{
  knobs({ brainPingpongFails: 10 });
  const b = build(ROOM);
  const turns = await play(b, 80, (t) => (t.tabu?.removed ?? []).includes('run_away'));
  ok(turns.some((t) => (t.tabu?.removed ?? []).includes('run_away')), '2b: T3 rules run_away out without the ping-pong rule');
  ok(events(b.run).some((e) => /^Ruled out run away: \d+ steps of it with the enemy no further away\./.test(e)), `2b: T3 event (${events(b.run).filter((e) => /Ruled/.test(e)).join(' | ')})`);
  knobs({});
}

// 2c. Off: the same game never rules anything out and keeps run_away on every menu.
{
  knobs({ tabuEnabled: false });
  const b = build(ROOM);
  const turns = await play(b, 60);
  ok(turns.every((t) => t.tabu === null), '2c: turn.tabu is null with the toggle off');
  ok(tacticMenus(b.reqs).every((m) => m.includes('run_away')), '2c: run_away stays on every menu');
  ok(!events(b.run).some((e) => /Ruled out/.test(e)), '2c: no rule-out event');
  knobs({ tabuTactics: false });
  const b2 = build(ROOM);
  await play(b2, 60);
  ok(tacticMenus(b2.reqs).every((m) => m.includes('run_away')), '2c: the tactic level off keeps run_away too');
  knobs({});
}

// 2d. On with no stall changes nothing: a short game with the toggle on and off sends byte-identical requests.
{
  const bodies = [];
  for (const on of [true, false]) {
    knobs({ tabuEnabled: on });
    const b = build({ ...ROOM, size: [15, 9], start: [2, 5], adversaries: [[14, 5]] });
    await play(b, 6);
    bodies.push(b.reqs.map((r) => r.body).join('\n'));
  }
  knobs({});
  // Jev options are shuffled with Math.random: compare as sets of questions per request instead of raw order.
  const norm = (s) => s.split('\n').map((b) => JSON.stringify(sortDeep(JSON.parse(b)))).join('\n');
  ok(norm(bodies[0]) === norm(bodies[1]), '2d: no stall = the same requests with the toggle on and off');
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}

// 2e. A live directive: the menu filter stands aside (the player's call); run_away is back on the menu.
{
  knobs({});
  const b = build(ROOM);
  await play(b, 60, (t) => (t.tabu?.removed ?? []).includes('run_away'));
  b.run.explorer.setDirective('hold the room', { steps: 10 });
  const n = b.reqs.length;
  await play(b, 6);
  const menus = tacticMenus(b.reqs.slice(n));
  ok(menus.length > 0 && menus.every((m) => m.includes('run_away')), `2e: with a directive run_away is offered again (${JSON.stringify(menus)})`);
}

// 2g. T4: engage keeps costing lives with no strike landed (the explorer walks in and never swings).
// 2h. T2: the same with T4 switched off: two `hit` re-decisions under engage with nothing gained rule it out.
const DUEL = { size: [11, 9], start: [2, 5], adversaries: [[9, 5]], ghostHp: 5, treasure: null, seed: 5 };
for (const [name, extra, re] of [
  ['2g T4', {}, /^Ruled out engage: \d+ hits taken with no strike landed\./],
  ['2h T2', { tabuEngageHits: 10 }, /^Ruled out engage: picked 2 times with nothing gained\./],
]) {
  knobs(extra);
  const b = build(DUEL, { tactic: 'engage', skill: 'none', claw: true, walkIn: true, opts: { hold: false } });
  const turns = await play(b, 80, (t) => (t.tabu?.removed ?? []).includes('engage'));
  const evs = events(b.run);
  ok(evs.some((e) => re.test(e)), `${name}: engage is ruled out (${evs.join(' | ')}; lives ${b.run.game.health})`);
  const t = turns.find((x) => (x.tabu?.removed ?? []).includes('engage'));
  ok(t && t.decision?.tactic && !('engage' in t.decision.tactic.options) && t.reqs.every((r) => !('engage' in (r.questions.tactic?.criteria ?? {}))), `${name}: the rule-out tick's tactic menu has no engage`);
  knobs({});
}

// 2i. A real fight that lands strikes is never ruled out: the explorer strikes whenever it can.
{
  knobs({});
  const b = build(DUEL, { tactic: 'engage', skill: 'strike', claw: true });
  await play(b, 60);
  ok(!events(b.run).some((e) => /Ruled out engage/.test(e)), `2i: a fight that lands strikes keeps engage (${events(b.run).join(' | ')})`);
}

// 2j. Determinism: the same arena and stubs give the same rule-outs at the same steps.
{
  const runs = [];
  for (let i = 0; i < 2; i++) {
    knobs({});
    const b = build(ROOM);
    const turns = await play(b, 50);
    runs.push(JSON.stringify(turns.map((t) => [t.step, t.dir, t.tabu?.removed, t.tabu?.tactic?.map((e) => e.attr)])));
  }
  ok(runs[0] === runs[1], '2j: deterministic');
}

// 2k. A rule-out the never-empty rule lifts again is never announced: with no sword in a closed room run_away is the only
// tactic, so it stays on the menu and no event claims otherwise.
{
  knobs({});
  const b = build({ ...ROOM, explorerSkills: 'none' });
  const turns = await play(b, 60);
  ok(turns.some((t) => (t.tabu?.lifted ?? []).includes('run_away')), '2k: the rule-out happened and was lifted');
  ok(!events(b.run).some((e) => /Ruled out/.test(e)), `2k: no rule-out event while the option is still offered (${events(b.run).join(' | ')})`);
}

// ---- 3. Phase 2: moods (D1, D2) -------------------------------------------------------------------------------------
// The real confidence model picks the tier. Capability capped at 40 puts the explorer in the middle-low tier (cautious,
// steady, bold on offer); at 60 in the middle tier. The tactic level is off (a stubborn run_away would be ruled out
// first) and the re-decision cooldown is 1, so the stalls come quickly.
const CONF = confidenceSnapshot();
const conf = (o = {}) => configureConfidence({ ...CONF, ...o });
const MIDLOW = { confCapabilityMax: 40, confUnhurtFloor: 40 };
const moodReqs = (b) => b.reqs.filter((r) => r.questions.sentiment);
const hasMood = (r, id) => id in r.questions.sentiment.criteria;
const removedAt = (turns, id) => turns.findIndex((t) => (t.tabu?.removed_moods ?? []).includes(id));
const stubborn = async (kn, ctl = {}, ticks = 100, cfg = MIDLOW, arena = ROOM) => {
  knobs({ tabuTactics: false, brainRedecideCooldown: 1, brainPingpongFails: 2, ...kn });
  conf(cfg);
  const b = build(arena, { mood: 'cautious', opts: { confidence: {} }, ...ctl });
  ctl.setup?.(b);
  const turns = await play(b, ticks);
  return { b, turns };
};

// 3a. D1: a stub that always answers cautious re-decides with nothing gained: cautious leaves the next sentiment request
// (its criteria and the mood list in the question text), once, with one memory event.
{
  const { b, turns } = await stubborn({});
  const at = removedAt(turns, 'cautious');
  ok(at >= 0, `3a: cautious is ruled out (${events(b.run).join(' | ')})`);
  if (at >= 0) {
    const t = turns[at];
    const sent = t.reqs.find((r) => r.questions.sentiment);
    ok(sent && !hasMood(sent, 'cautious') && !/regrouping \(cautious\)/.test(sent.questions.sentiment.instructions), '3a: the rule-out tick\'s sentiment request has no cautious in criteria or question text');
    ok(sent && /Only the moods your confidence allows are listed: [^.]*\(steady\)[^.]*\(bold\)/.test(sent.questions.sentiment.instructions), '3a: the question text still lists the other moods');
    const before = moodReqs(b).filter((r) => r !== sent && b.reqs.indexOf(r) < b.reqs.indexOf(sent));
    ok(before.length >= 2 && before.every((r) => hasMood(r, 'cautious')), `3a: every earlier sentiment request offered cautious (${before.length})`);
    const redecisions = turns.slice(0, at + 1).filter((x) => ['tactic_failed', 'hit', 'confidence'].includes(x.decision?.trigger)).length;
    ok(redecisions >= 2, `3a: it took at least 2 re-decisions (${redecisions})`);
    ok(t.tabu.mood?.some((e) => e.attr === 'cautious' && e.steps_left === 'encounter'), '3a: turn.tabu.mood lists it for the encounter');
    ok(moodReqs(b).filter((r) => b.reqs.indexOf(r) > b.reqs.indexOf(sent)).slice(0, 2).every((r) => !hasMood(r, 'cautious')), '3a: later requests stay without cautious');
  }
  ok(events(b.run).filter((e) => /^Ruled out cautious: /.test(e)).length === 1, '3a: exactly one memory event for cautious');
  ok(events(b.run).some((e) => /^Ruled out cautious: picked 2 times with nothing gained\.$/.test(e)), '3a: the event says why');
}

// 3b. D2: always-failing reviews outside an encounter rule the mood on out for 20 steps; a review that judged it working
// resets the count.
{
  const FIELD = { size: [40, 12], start: [2, 6], numAdversaries: 0, treasure: null, ghostSkills: 'none', seed: 4 };
  knobs({});
  conf({ confCapabilityMax: 60, confUnhurtFloor: 40 });
  const b = build(FIELD, { working: 0.1, opts: { confidence: {} } });
  const turns = await play(b, 70);
  const at = turns.findIndex((t) => t.tabu?.mood?.some((e) => e.attr === 'steady'));
  ok(at >= 0, `3b: steady is ruled out after failing reviews (${events(b.run).join(' | ')})`);
  if (at >= 0) {
    ok(turns[at].review?.working < 0.5 && turns.slice(0, at).filter((t) => t.review && t.review.working < 0.5).length === 1, '3b: on the second failing review in a row');
    ok(turns[at].tabu.mood.find((e) => e.attr === 'steady').steps_left === 20, '3b: for 20 steps');
    const later = turns.slice(at + 1).find((t) => t.reqs.some((r) => r.questions.sentiment));
    ok(later && later.reqs.filter((r) => r.questions.sentiment).every((r) => !hasMood(r, 'steady')), '3b: the next sentiment request has no steady');
    ok(later && /steady ruled out/.test(JSON.stringify(turns.slice(at, turns.indexOf(later) + 1).map((t) => t.policy))), '3b: the silent swap says why');
    const back = turns.slice(at + 20).find((t) => t.reqs.some((r) => r.questions.sentiment));
    ok(back && back.reqs.filter((r) => r.questions.sentiment).some((r) => hasMood(r, 'steady')), '3b: after 20 steps steady is on offer again');
  }
  ok(events(b.run).filter((e) => /^Ruled out steady: 2 approach reviews in a row/.test(e)).length === 1, '3b: one memory event');
  // reset: a review that judged the approach working in between
  let n = 0;
  knobs({});
  const b2 = build(FIELD, { working: () => (n++ % 2 ? 0.9 : 0.1), opts: { confidence: {} } });
  const turns2 = await play(b2, 90);
  ok(turns2.filter((t) => t.review).length >= 4 && turns2.every((t) => !t.tabu?.mood?.length), '3b: failing reviews that are not in a row rule nothing out');
  // off
  knobs({ tabuMoods: false });
  const b3 = build(FIELD, { working: 0.1, opts: { confidence: {} } });
  const turns3 = await play(b3, 70);
  ok(turns3.every((t) => !t.tabu?.mood?.length) && moodReqs(b3).every((r) => hasMood(r, 'steady') || !hasMood(r, 'bold')), '3b: tabuMoods off rules no mood out');
}

// 3c. Last life: wary and guarded are never both off the menu (the never-empty rule lifts the older entry).
{
  const regen = REGEN_STEPS;
  configureWorld({ regenSteps: 0 }); // the half life it would heal after 30 steps would end the last-life case
  const { b, turns } = await stubborn({}, { mood: 'wary', setup: (x) => { x.run.game.health = 1; } }, 160, { confPanicEnter: 0 });
  const sents = turns.filter((t) => t.decision?.sentiment);
  ok(sents.length >= 3 && sents.every((t) => t.decision.sentiment.options.some((o) => o === 'wary' || o === 'guarded')), `3c: every sentiment decision offers wary or guarded (${sents.map((t) => t.decision.sentiment.options.join('/')).join(' ')})`);
  ok(moodReqs(b).every((r) => hasMood(r, 'wary') || hasMood(r, 'guarded')), '3c: so does every sentiment request');
  ok(turns.some((t) => (t.tabu?.removed_moods ?? []).length) && turns.some((t) => (t.tabu?.lifted_moods ?? []).length), `3c: the rule-out and the lift both happened (${events(b.run).join(' | ')})`);
  ok(turns.every((t) => (t.tabu?.removed_moods ?? []).length < 2), '3c: never both removed');
  configureWorld({ regenSteps: regen });
}

// 3d. Aspirations. panic is code's: nothing is ruled out under it. The fixedMood arm is never filtered. A directive suspends it.
{
  const { b, turns } = await stubborn({}, { mood: 'wary', setup: (x) => { x.run.game.health = 1; } }, 60, { confCapabilityMax: 5, confUnhurtFloor: 0 });
  ok(turns.some((t) => t.confidence?.panic) && turns.every((t) => !t.tabu?.mood?.length && !(t.tabu?.removed_moods ?? []).length), '3d: panic is never ruled out or filtered');
  const p0 = turns.findIndex((t) => t.confidence?.panic);
  ok(p0 >= 0 && turns.filter((t) => t.confidence?.panic).every((t) => !t.decision?.sentiment || t.decision.sentiment.automatic), '3d: panic asks no sentiment question');

  const fx = await stubborn({}, { mood: 'wary', opts: { confidence: { fixedMood: true } } }, 100, MIDLOW);
  ok(moodReqs(fx.b).length >= 3 && moodReqs(fx.b).every((r) => hasMood(r, 'wary') && hasMood(r, 'bold')), '3d: the fixedMood arm offers all four classic moods every time');
  ok(fx.turns.every((t) => !t.tabu?.mood?.length && !(t.tabu?.removed_moods ?? []).length), '3d: the fixedMood arm rules nothing out');

  const d = await stubborn({}, {}, 100);
  const at = removedAt(d.turns, 'cautious');
  ok(at >= 0, '3d: (setup) cautious is ruled out');
  if (at >= 0) {
    d.b.run.explorer.setDirective('wait here', { steps: 10 });
    const n = d.b.reqs.length;
    await play(d.b, 8);
    const sent = d.b.reqs.slice(n).filter((r) => r.questions.sentiment);
    ok(sent.length > 0 && sent.every((r) => hasMood(r, 'cautious')), `3d: with a directive cautious is on offer again (${sent.length} requests)`);
  }
}

// 3e. Off: tabuMoods off (tactic level off too) sends byte-for-byte the requests of tabuEnabled off in the stubborn scenario;
// with no stall the requests are the same on and off.
{
  const bodiesOf = async (kn, ticks, cfg) => {
    const { b } = await stubborn(kn, {}, ticks, cfg);
    return b.reqs.map((r) => JSON.stringify(sortDeep(JSON.parse(r.body)))).join('\n');
  };
  const a = await bodiesOf({ tabuEnabled: false }, 100);
  const m = await bodiesOf({ tabuMoods: false, tabuTactics: false }, 100);
  const on = await bodiesOf({}, 100);
  ok(a === m, '3e: tabuMoods + tabuTactics off = tabuEnabled off, byte for byte');
  ok(a !== on, '3e: (control) the stubborn scenario differs with the mood level on');
  const quiet = [];
  for (const kn of [{ tabuEnabled: false }, {}]) {
    knobs({ ...kn });
    conf(MIDLOW);
    const q = build({ ...ROOM, size: [15, 9], start: [2, 5], adversaries: [[14, 5]] }, { opts: { confidence: {} } });
    await play(q, 6);
    quiet.push(q.reqs.map((r) => JSON.stringify(sortDeep(JSON.parse(r.body)))).join('\n'));
  }
  ok(quiet[0] === quiet[1] && quiet[0].length > 0, '3e: no stall = identical requests on and off');
}

// 3f. Determinism.
{
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const { b, turns } = await stubborn({}, {}, 80);
    runs.push(JSON.stringify([turns.map((t) => [t.step, t.dir, t.tabu]), b.reqs.map((r) => r.body)]));
  }
  ok(runs[0] === runs[1], '3f: two runs give identical turns and requests');
}

conf({});
knobs({});
rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('check-tabu: all checks passed');
