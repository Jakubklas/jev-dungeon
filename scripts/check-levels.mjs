// Monster levels, explorer side (PLAN-levels.md L2): fog-safe level/claw reads, matchup(), engage gating, the facts Jev
// reads, the deterministic remark, levels off = unchanged, request bounds. Stubbed ask, no Jev, no network.
// Run from the dungeon-game directory: JEV_CONFIG=none node scripts/check-levels.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newTestGame } from '../src/turn.js';
import { KnownWorld } from '../src/characters/explorer/known-world.js';
import { matchup, configureExplorerEncounter, remarkLine } from '../src/characters/explorer/encounter.js';
import { configureLevels } from '../src/characters/adversary/kinds.js';
import { stepAdversaries, spawnAdversaries } from '../src/characters/adversary/adversary.js';
import { generateDungeon } from '../src/dungeon.js';
import { playDuel, clawDecide } from './lib/duel-harness.mjs';
import { REQUEST_BYTES } from '../src/config/registry.js';

let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log(`FAIL: ${msg}`); } };
globalThis.fetch = () => { throw new Error('fetch tripwire: level checks must not call Jev'); };

const ROOM = ['###############', '#.............#', '#.............#', '#..@..........#', '#.............#', '#.............#', '###############'];
const roomWith = (cells) => ROOM.map((r, y) => [...r].map((ch, x) => (cells.some(([cx, cy]) => cx === x && cy === y) ? 'A' : ch)).join(''));
const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });

// A stub that engages whenever engage is offered, else runs away; first option for everything else.
function makeAsk(log, holder = {}) {
  return async (req) => {
    log.push(JSON.stringify(req.body ?? { state: req.state, questions: req.questions }));
    const out = {};
    for (const [k, q] of Object.entries(req.questions)) {
      if (q.type === 'noul') { out[k] = { noul: 0.9 }; continue; }
      const opts = Object.keys(q.criteria ?? {});
      let pick = opts[0];
      if (k === 'tactic') pick = opts.includes('engage') ? 'engage' : opts.includes('run_away') ? 'run_away' : opts[0];
      else if (k === 'skill') pick = opts.find((x) => x !== 'none') ?? 'none';
      else if (opts.includes('bold') && k !== 'next_move') pick = 'bold';
      else if (k.startsWith('next_move') || k.startsWith('move_if')) {
        // follow the nearest monster to 2 steps off, then hold (the game is read by the test stub only)
        const g = holder.game, a = g?.adversaries[0];
        if (a) {
          const d = (p) => Math.abs(p[0] - a.pos[0]) + Math.abs(p[1] - a.pos[1]);
          const here = d(g.pos);
          const score = (o) => (o === 'stay' ? here : d([g.pos[0] + DIRS[o][0], g.pos[1] + DIRS[o][1]]));
          pick = here <= 2 && opts.includes('stay') ? 'stay' : opts.reduce((b, o) => (score(o) < score(b) ? o : b));
        }
      }
      out[k] = answer(pick);
    }
    return out;
  };
}

// Plays the shared duel harness (its stub follows the nearest monster and strikes) with a level set; records what the
// explorer said and every request body. `lives` is the explorer's lives, `kind`/`level` the one monster at [10,3].
async function duel({ kind, level, lives, ticks = 12, levelsOn = true }) {
  configureLevels({ levelsEnabled: levelsOn });
  const log = [], remarks = [], tacticOptions = [];
  const r = await playDuel({
    kinds: [kind], levels: [level], health: lives, maxTicks: ticks, policy: 'follow', mood: 'bold',
    onAsk: (req) => {
      log.push(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? { state: req.state, questions: req.questions }));
      const crit = req.questions?.tactic?.criteria;
      if (crit) tacticOptions.push(Object.keys(crit));
    },
    onTurn: (turn, game, run) => { const rm = run.view().explorer.remark; if (rm) remarks.push({ tick: turn.step ?? remarks.length, remark: rm }); },
  });
  return { ...r, log, remarks, tacticOptions };
}

// 1. KnownWorld reads: level and clawDamage in sight only.
{
  configureLevels({ levelsEnabled: true });
  const run = newTestGame({ map: roomWith([[10, 3]]), seed: 1, kinds: ['troll'], levels: [3] }, { ask: makeAsk([]) });
  const w = new KnownWorld(run.game);
  const v = w.visibleAdversaries();
  check(v.length === 1 && v[0].level === 3 && v[0].clawDamage === run.game.adversaries[0].clawDamage && v[0].hp === 6, `visibleAdversaries carries level and clawDamage: ${JSON.stringify(v)}`);
  check(w.levelsOn === true, 'KnownWorld.levelsOn follows the knob');
}

// 2. matchup() per the plan rule.
{
  configureLevels({ levelsEnabled: true });
  const mk = (health, hp, claw, level = 2) => ({ world: { levelsOn: true, health }, th: { hp, level, clawDamage: claw } });
  const m = (health, hp, claw, dmg = 1) => { const x = mk(health, hp, claw); return matchup(x.world, x.th, dmg); };
  check(m(2, 1, 1) === 'weak', 'hp 1, claw 1, 2 lives: weak');
  check(m(1, 1, 1) === 'even', 'hp 1, claw 1, 1 life: even (one claw kills)');
  check(m(2, 6, 3) === 'too_strong' && m(2, 4, 2) === 'too_strong', '2 lives vs a level-2/3 troll (claw 2/3): too strong');
  check(m(2, 2, 1) === 'even', '2 lives vs a level-2 ghost (hp 2, claw 1): even, never too strong');
  check(m(2, 1, 1) === 'weak' && m(9, 6, 3) === 'even', 'a level-1 ghost is weak; a troll at 9 lives is even');
  check(m(2, 2, 1, 2) === 'weak', 'a sword of damage 2 dispels hp 2 in one strike: weak');
  const off = mk(2, 6, 3);
  off.world.levelsOn = false;
  check(matchup(off.world, off.th, 1) === 'even', 'levels off: always even');
  check(matchup({ levelsOn: true, health: 2 }, { hp: 6 }, 1) === 'even', 'no level on the record: even');
  configureExplorerEncounter({ levelCautionClaws: 2 });
  check(m(2, 2, 1) === 'too_strong' && m(2, 1, 1) === 'even' && m(3, 1, 1) === 'weak', 'cautionClaws 2: the stricter rule');
  configureExplorerEncounter({ levelCautionClaws: 1 });
}

// 3. Duels. 2 lives vs a level-3 troll: declines, remarks; engage never offered, no strike.
{
  const d = await duel({ kind: 'troll', level: 3, lives: 2, ticks: 10 });
  check(d.remarks.length === 1 && d.remarks[0].remark === "I don't have enough health to fight this guy.", `too_strong remark once: ${JSON.stringify(d.remarks)}`);
  check(d.held === 0, 'the engage hold never starts against it');
  check(d.tacticOptions.every((o) => !o.includes('engage')), `engage is not offered: ${JSON.stringify(d.tacticOptions)}`);
  check(d.log.some((b) => b.includes('"level":3') && b.includes('claw_lives')), 'Jev is told the level and the claw');
}
// Full lives vs a level-1 ghost: engages, says the weak line.
{
  const d = await duel({ kind: 'ghost', level: 1, lives: 9, ticks: 14 });
  check(d.remarks.length >= 1 && d.remarks[0].remark === "Ah, that's a weak target.", `weak remark: ${JSON.stringify(d.remarks)}`);
  check(d.strikes >= 1 && d.dispelled >= 1, `the explorer engages and dispels a level-1 ghost (strikes ${d.strikes}, dispelled ${d.dispelled})`);
  check(d.tacticOptions.some((o) => o.includes('engage')), 'engage is offered against a weak target');
  check(d.log.some((b) => b.includes('A weak target')), 'the engage fact carries the weak-target line');
}
// An even match: no remark.
{
  const d = await duel({ kind: 'troll', level: 2, lives: 9, ticks: 4 });
  check(d.remarks.length === 0, 'an even match draws no remark');
}
// 2 lives vs a level-2 ghost: ordinary fight, engages, no too_strong remark.
{
  const d = await duel({ kind: 'ghost', level: 2, lives: 2, ticks: 14 });
  check(d.remarks.every((r) => r.remark !== "I don't have enough health to fight this guy."), 'level-2 ghost at 2 lives: no too_strong remark');
  check(d.tacticOptions.some((o) => o.includes('engage')) && d.strikes >= 1, `level-2 ghost at 2 lives: engages (strikes ${d.strikes})`);
}
// Cornered: a dead end, the too-strong troll right behind: engage stays on the menu.
{
  configureLevels({ levelsEnabled: true });
  const dir = mkdtempSync(join(tmpdir(), 'jev-levels-'));
  const url = pathToFileURL(dir + '/');
  try {
    const run = newTestGame({ map: ['#########', '#########', '#@.A....#', '#########', '#########'], seed: 1, explorerSkills: ['sword_strike'], kinds: ['troll'], levels: [3] }, { ask: makeAsk([]), dir: url, memoryDir: url });
    run.game.health = run.game.maxHealth = 2;
    run.game.adversaries[0].mode = 'chase';
    const { tacticFeasibility } = await import('../src/characters/explorer/perception.js');
    const f = tacticFeasibility(new KnownWorld(run.game), 3, { armed: true });
    check(Boolean(f.engage), `cornered in a dead end: engage stays offered (${Object.keys(f)})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 4. Remark pools: deterministic, walked in order, wrap.
{
  check(remarkLine('weak_target', 0) === "Ah, that's a weak target." && remarkLine('too_strong', 0) === "I don't have enough health to fight this guy.", 'pool heads are the default lines');
  check(remarkLine('weak_target', 4) === remarkLine('weak_target', 0), 'the pool wraps');
  configureExplorerEncounter({ the_weak_target: ['A.', 'B.'], the_too_strong: null });
  check(remarkLine('weak_target', 1) === 'B.' && remarkLine('too_strong', 0) === "I don't have enough health to fight this guy.", 'a text knob replaces a pool; null restores it');
  configureExplorerEncounter({ the_weak_target: null });
}

// 5. Levels off: nothing about levels reaches Jev, no remark, engage as before.
{
  const d = await duel({ kind: 'troll', level: 3, lives: 2, ticks: 8, levelsOn: false });
  check(d.remarks.length === 0, 'levels off: no remark');
  check(d.log.every((b) => !b.includes('claw_lives') && !b.includes('"level"')), 'levels off: no level in any request');
  check(d.tacticOptions.some((o) => o.includes('engage')), 'levels off: engage is offered as before');
}

// 6. Fog: an unseen monster's level never reaches a request. Level 3 is the only monster with a '"level":3' tell.
{
  configureLevels({ levelsEnabled: true });
  // The explorer starts in a closed room; the troll (level 3) is behind a wall, never in sight.
  const dir = mkdtempSync(join(tmpdir(), 'jev-levels-'));
  const url = pathToFileURL(dir + '/');
  const log = [];
  try {
    const map = ['###########', '#@.......##', '#########.#', '#########A#', '###########'];
    const run = newTestGame({ map, seed: 1, explorerSkills: ['sword_strike'], kinds: ['troll'], levels: [3] }, { ask: makeAsk(log), decide: async () => ({}), dir: url, memoryDir: url });
    run.game.adversaries[0].mode = 'patrol';
    for (let t = 0; t < 3; t++) await run.playTurn();
    const seenNow = new KnownWorld(run.game).visibleAdversaries().length;
    check(seenNow === 0 && log.length > 0, 'fog scenario: the troll stays unseen');
    check(log.every((b) => !b.includes('"level"') && !b.includes('claw_lives') && !b.includes('troll')), 'fog: no level, claw or kind of an unseen monster in any request');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// Frozen at the sighting: after it leaves sight the remembered record keeps the sighted level, not a later one.
{
  const d = await duel({ kind: 'troll', level: 3, lives: 2, ticks: 6 });
  const rem = d.log.map((b) => JSON.parse(b)).flatMap((b) => b.state?.threats?.remembered ?? []);
  check(rem.every((r) => r.level === 3 || r.level === undefined), 'remembered sightings carry the level they were seen at');
}

// 8. Claw damage follows the level (kind claw x dmgMult): reported == the skill's damage == lives an actual claw takes.
{
  configureLevels({ levelsEnabled: true });
  const clawOf = (a) => a.skills.skills.find((k) => k.kind === 'attack').damage;
  const want = { 'ghost1': 1, 'ghost2': 1, 'troll2': 2, 'troll3': 3 };
  // The server path: spawned monsters of 40 seeds.
  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    for (const a of spawnAdversaries(generateDungeon(seed))) {
      const k = `${a.kind}${a.level}`;
      seen.add(k);
      check(a.clawDamage === clawOf(a) && a.clawDamage === want[k], `spawned ${k}: claw ${a.clawDamage} (skill ${clawOf(a)}, want ${want[k]})`);
    }
  }
  check(['ghost1', 'ghost2', 'troll2', 'troll3'].every((k) => seen.has(k)), 'spawn covers ghost 1/2 and troll 2/3');
  // The testbed path.
  for (const [kind, level] of [['ghost', 1], ['ghost', 2], ['troll', 2], ['troll', 3]]) {
    for (const mode of ['testbed']) {
      const run = newTestGame({ map: ['#######', '#######', '#@A...#', '#######', '#######'], seed: 1, kinds: [kind], levels: [level] }, { ask: makeAsk([]) });
      const a = run.game.adversaries[0];
      check(a.clawDamage === clawOf(a) && a.clawDamage === want[`${kind}${level}`], `${mode} ${kind}${level}: claw ${a.clawDamage} (skill ${clawOf(a)})`);
      // An actual claw hit takes that many lives.
      run.game.health = run.game.maxHealth = 9;
      a.mode = 'chase';
      let lost = 0;
      for (let t = 0; t < 14 && lost === 0; t++) { await stepAdversaries(run.game, { decide: clawDecide }); lost = 9 - run.game.health; }
      check(lost === want[`${kind}${level}`], `${kind}${level}: one real claw hit takes ${lost} lives (want ${want[`${kind}${level}`]})`);
    }
  }
}

// 9. Fog for the remark: a visible even-matchup troll and an unseen level-1 ghost (weak on sight) -> no weak remark,
// and the ghost's level, claw and id never reach a request.
{
  configureLevels({ levelsEnabled: true });
  const dir = mkdtempSync(join(tmpdir(), 'jev-levels-'));
  const url = pathToFileURL(dir + '/');
  const log = [];
  try {
    const map = ['###########', '#@..A.....#', '#########.#', '#########A#', '###########'];
    const run = newTestGame({ map, seed: 1, explorerSkills: ['sword_strike'], kinds: ['troll', 'ghost'], levels: [2, 1] }, { ask: makeAsk(log), decide: async () => ({}), dir: url, memoryDir: url });
    const g = run.game;
    g.health = g.maxHealth = 4;
    g.adversaries.forEach((a) => { a.mode = 'patrol'; });
    const remarks = [];
    for (let t = 0; t < 2; t++) { await run.playTurn(); const r = run.view().explorer.remark; if (r) remarks.push(r); }
    const vis = new KnownWorld(g).visibleAdversaries().map((v) => v.id);
    check(vis.includes('a1') && !vis.includes('a2'), `setup: the troll is visible, the ghost is not (${vis})`);
    check(remarks.every((r) => r !== "Ah, that's a weak target."), `no weak remark from an unseen level-1 ghost: ${JSON.stringify(remarks)}`);
    check(log.every((b) => !b.includes('"a2"') && !b.includes('"level":1')), 'the unseen ghost (id, level 1) is in no request');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 10. The level facts reach Jev in the option text: engage says level and claw vs your lives; run_away says why when it is too strong.
{
  const d = await duel({ kind: 'ghost', level: 2, lives: 4, ticks: 3 });
  check(d.log.some((b) => /Level 2, its claw takes 1 life; you have 4\./.test(b)), 'the engage option states level, claw and your lives');
  configureLevels({ levelsEnabled: true });
  const run = newTestGame({ map: roomWith([[10, 3]]), seed: 1, explorerSkills: ['sword_strike'], kinds: ['troll'], levels: [3] }, { ask: makeAsk([]) });
  run.game.health = run.game.maxHealth = 2;
  const { tacticFeasibility } = await import('../src/characters/explorer/perception.js');
  const f = tacticFeasibility(new KnownWorld(run.game), 3, { armed: true });
  check(/a1 is too strong to fight \(Level 3, its claw takes 3 lives; you have 2\)/.test(f.run_away?.fact ?? ''), `run_away says why the troll is too strong: ${f.run_away?.fact}`);
  check(!f.engage, 'and engage is off the menu');
}

// 7. Request bounds with a level-3 troll in sight (the largest levels-on request).
{
  const d = await duel({ kind: 'troll', level: 3, lives: 9, ticks: 6 });
  const max = Math.max(...d.log.map((b) => b.length));
  check(max <= REQUEST_BYTES.explorerChasing, `largest request ${max} bytes (> ${REQUEST_BYTES.explorerChasing})`);
  console.log(`  largest levels-on request in the duel: ${max} bytes (bound ${REQUEST_BYTES.explorerChasing})`);
}

configureLevels({ levelsEnabled: true });
if (fails) { console.log(`check-levels: ${fails} failure(s)`); process.exit(1); }
console.log('check-levels: ok');
