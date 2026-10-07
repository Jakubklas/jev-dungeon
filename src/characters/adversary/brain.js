// An adversary's brain: one Jev request per adversary step while the brain is on.
// Code observes (perception.js), Jev decides, memory.js remembers. adversary.js runs the
// on/off state machine and calls decide() for every brain-on adversary with a step this tick,
// all in parallel.
//
// FOG: the explorer's position reaches Jev only while hunt.inSight (seesExplorer) is true.
// Out of sight, Jev gets last_seen only. Never the treasure, never the explorer's light/visits.
// Each Adversary keeps the exact body of its last request, for auditing.
//
// Code policies (no Jev): switch on at startsChase, direct_pursuit while in sight, take a move
// that catches the explorer, take the only legal move, switch off after MAX_SEARCH_TICKS.
// Jev decides: every other move, cut_off vs sweep_last_seen on the first search step, and
// keep_hunting on every search step.
import { DIRS, SIGHT_RANGE, floorDistances } from '../../dungeon.js';
import { APPROACHES, SEARCH_APPROACHES, adversaryMoves, approachOption, compass8, describeMoves, situation, stepCell, sweep } from './perception.js';
import { addEvent, brainOff, brainOn, count, createMemory, recordAction, setApproach } from './memory.js';
import { askJev, shuffle } from '../../jev.js';

export let KEEP_HUNTING_MIN = 0.5; // keep_hunting.noul below this switches the brain off (live: src/settings.js)
export const setKeepHuntingMin = (v) => { KEEP_HUNTING_MIN = v; };

const key = ([x, y]) => `${x},${y}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

// The rules text, built from the live tunables: speed, search time, hit damage, grace ticks (cfg) and SIGHT_RANGE.
function rules({ speed, maxSearchTicks, hitDamage = 1, graceTicks = 4 }) {
  const lives = hitDamage === 1 ? 'a life' : `${hitDamage} lives`;
  return (
    'A dungeon on a grid of walls and floor. You are one of several adversaries hunting an explorer who is looking for a hidden treasure chest. ' +
    `You move one cell per step (up, down, left or right) at ${Math.round(speed * 100)}% of the explorer's speed, so you cannot outrun it in a straight race. ` +
    `You know the whole map. You see the explorer only with a clear line of sight within ${SIGHT_RANGE} cells; out of sight you only know where and when you last saw it and which way it was heading. ` +
    `Stepping onto the explorer's cell hits it: it loses ${lives} and you are knocked back; it is caught when its last life is gone, and right after a hit it cannot be hurt for ${graceTicks} tick${graceTicks === 1 ? '' : 's'}. Adversaries may share a cell. ` +
    'Your objective: catch the explorer before it finds the treasure. ' +
    `If you stop hunting, or go ${maxSearchTicks} ticks without seeing the explorer, you go back to patrolling.`
  );
}

// Hunt state of one adversary (owned by the Adversary as a private field, so its contracted shape
// stays the same).
//   on, inSight (seesExplorer this tick), heading (explorer's last move when last seen, frozen out of
//   sight), ticksSinceSeen, swept (cells checked since sight was lost), cutOff (cached cut-off point),
//   dists (recent path distances while in sight), trend (frozen distance trend), pickApproach,
//   probabilities (of the last next_move answer: for the UI only, Jev never reads them), memory
export function newHunt(id) {
  return { on: false, inSight: false, heading: null, ticksSinceSeen: 0, swept: new Set(), cutOff: null, dists: [], trend: null, pickApproach: false, probabilities: null, memory: createMemory(id) };
}

// Default Jev call, in the shape of an injected `ask`.
const jevAsk = ({ state, questions, body }) => askJev(state, questions, body);

// Direction of the explorer's latest move, read only while it is in sight.
function explorerHeading(game) {
  const t = game.trail ?? [];
  if (t.length < 2) return null;
  const [a, b] = t.slice(-2);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return Object.keys(DIRS).find((d) => DIRS[d][0] === dx && DIRS[d][1] === dy) ?? null;
}

function trendText(dists) {
  if (dists.length < 2) return `${dists[0] ?? '?'} path steps away`;
  const first = dists[0], last = dists.at(-1);
  const word = last < first ? 'closing' : last > first ? 'widening' : 'steady';
  return `${word}: ${first} → ${last} path steps over the last ${dists.length - 1} tick${dists.length === 2 ? '' : 's'}`;
}

// --- state transitions (called by adversary.js) -------------------------------------------

// The explorer is in sight now (seesExplorer). Call once per sense.
export function seen(game, a, tick, { startOfTick }) {
  const h = a.hunt;
  const resighted = !h.inSight; // sight is called twice a tick: only the change counts
  h.inSight = true;
  h.heading = explorerHeading(game) ?? h.heading;
  h.ticksSinceSeen = 0;
  h.swept.clear();
  h.cutOff = null;
  h.pickApproach = false;
  if (startOfTick) {
    const d = floorDistances(game.dungeon, a.pos).get(key(game.pos));
    if (d !== undefined) h.dists = [...h.dists, d].slice(-4);
  }
  const m = h.memory;
  if (resighted && count(m, 'sightings') === 1) {
    const n = Math.round(Math.hypot(game.pos[0] - a.pos[0], game.pos[1] - a.pos[1]));
    addEvent(m, `First sighting: the explorer to the ${compass8(a.pos, game.pos)}, about ${n} cells away.`, tick);
  }
  m.progress.ticks_since_seen = 0;
  m.progress.distance_trend = trendText(h.dists);
  setApproach(m, { id: 'direct_pursuit', text: APPROACHES.direct_pursuit.text }, 'the explorer is in sight again', tick);
}

export function switchOn(game, a, tick) {
  const h = a.hunt;
  h.on = true;
  h.dists = [];
  brainOn(h.memory, tick, 'spotted the explorer');
  seen(game, a, tick, { startOfTick: true });
}

// A neighbour spotted the explorer and shouted: this adversary joins the hunt in search mode at the
// spot where it was seen, heading as it was then. No sight, so nothing beyond last_seen leaks.
export function switchOnAlerted(a, tick, at, heading, by) {
  const h = a.hunt;
  h.on = true;
  h.inSight = false;
  h.dists = [];
  h.heading = heading;
  h.ticksSinceSeen = 0;
  h.swept.clear();
  h.cutOff = null;
  h.pickApproach = true;
  h.trend = null;
  brainOn(h.memory, tick, `${by} spotted the explorer and called for help`);
  setApproach(h.memory, { id: 'sweep_last_seen', text: APPROACHES.sweep_last_seen.text }, `${by} called for help`, tick);
  count(h.memory, 'alerts_heard');
  addEvent(h.memory, `${by} spotted the explorer and called for help; last seen at [${at[0]}, ${at[1]}].`, tick);
}

// Sight lost: the next step picks a search approach.
export function lostSight(game, a, tick) {
  const h = a.hunt;
  h.inSight = false;
  h.trend = h.memory.progress.distance_trend;
  h.pickApproach = true;
  h.cutOff = null;
  sweepFrom(game, a);
  count(h.memory, 'lost_sight');
}

// Once per tick while searching.
export function searchTick(a) {
  const h = a.hunt;
  h.inSight = false;
  h.ticksSinceSeen += 1;
  h.memory.progress.ticks_since_seen = h.ticksSinceSeen;
  h.memory.progress.distance_trend = `out of sight for ${h.ticksSinceSeen} tick${h.ticksSinceSeen === 1 ? '' : 's'}; before that ${h.trend ?? 'unknown'}`.slice(0, 160);
}

export function hunted(a) {
  a.hunt.memory.progress.ticks_hunting += 1;
}

// Marks what this adversary sees from its cell as checked (search mode only).
export function sweepFrom(game, a) {
  sweep(game.dungeon, a.hunt, a.pos);
}

export function switchOff(a, tick, reason) {
  const h = a.hunt;
  h.on = false;
  h.inSight = false;
  h.swept.clear();
  h.cutOff = null;
  h.dists = [];
  h.pickApproach = false;
  h.ticksSinceSeen = 0;
  brainOff(h.memory, tick, reason);
  addEvent(h.memory, `Gave up: ${reason}`, tick);
}

// This adversary just hit the explorer (called by adversary.js touchCheck).
export function noteHit(a, tick) {
  const m = a.hunt.memory;
  addEvent(m, `Hit the explorer (hit ${count(m, 'hits')}).`, tick);
}

// --- the decision -------------------------------------------------------------------------

// What Jev reads, grouped like the explorer's state. `recent` and `self.approach` are the persistent
// memory (memory.js); the rest is recomputed from the real map each step (perception.js), and the
// explorer block holds a position only while it is in sight.
function jevState(game, a, h, tick, rulesText) {
  const m = h.memory;
  const { position, surroundings, explorer, last_seen, team, ...search } = situation(game, a, h);
  return {
    game: rulesText,
    tick,
    self: { id: a.id, position, mode: h.inSight ? 'chase' : 'search', approach: m.approach, latest_action: m.latest_action },
    surroundings,
    explorer,
    last_seen,
    ...search,
    team,
    recent: { tally: m.tally, events: m.events, progress: m.progress },
  };
}

// Builds the request for one step. Pure: no state changes. Returns { legal, forced } when no
// Jev call is needed (code policy), else { legal, state, questions, body, options }.
export function buildRequest(game, a, tick, cfg) {
  const { speed, maxSearchTicks } = cfg;
  const h = a.hunt;
  const legal = adversaryMoves(game.dungeon, a.pos);
  if (!legal.length) return { legal, forced: null };
  // Code policy: a move onto the (visible) explorer is always taken.
  if (h.inSight) {
    const catching = legal.find((d) => same(stepCell(a.pos, d), game.pos));
    if (catching) return { legal, forced: catching };
  }
  const searching = !h.inSight;
  const approachIds = searching ? (h.pickApproach ? SEARCH_APPROACHES : [h.memory.approach.id]) : ['direct_pursuit'];
  const questions = {};
  let options = null;
  if (legal.length > 1) {
    const moves = describeMoves(game, a, h, approachIds, speed);
    options = Object.fromEntries(shuffle(legal).map((d) => [d, moves[d]]));
    const priorities = searching
      ? [
          h.pickApproach
            ? 'The explorer was just lost from sight and the search approach is being chosen this step (`search_approach`): prefer the move that serves the better search approach, starting from the path to the last-seen cell.'
            : 'Follow `self.approach.current`: prefer the move that brings this adversary closer to `approach_target`.',
          'Prefer moves that bring unchecked cells into view over moves that bring nothing new into view.',
          'Avoid undoing the previous move (`self.latest_action`) unless the target lies behind.',
          'Standing in a corridor, doorway or junction the explorer must pass is better than open room floor.',
        ]
      : [
          'You are slower than the explorer, so chasing from behind never catches it: the hit comes from cutting off its escape routes. Prefer the move that cuts off the most cells, especially cells no other adversary covers, so the explorer is boxed in between you and the others.',
          'Among moves that cut off about as much, prefer one that closes the path distance (`explorer.path_steps`), then one that keeps the explorer in sight, then one that blocks a corridor, doorway or junction ahead of it (`explorer.heading`).',
        ];
    questions.next_move = {
      type: 'choice',
      instructions: {
        question: searching && h.pickApproach
          ? 'The explorer just went out of sight. Which way should this adversary step next to achieve its objective, starting the search from `last_seen`? Judge each move from its description, the state and `recent.progress`.'
          : 'Which way should this adversary step next to achieve its objective, following `self.approach.current`? Judge each move from its description, the state and `recent.progress`.',
        priorities,
      },
      criteria: options,
    };
  }
  if (searching && h.pickApproach) {
    questions.search_approach = {
      type: 'choice',
      instructions:
        'The explorer just went out of sight (`last_seen`). Which search approach gives this adversary the best chance to catch it? Use `last_seen.heading`, the map facts and how far each target is.',
      criteria: Object.fromEntries(shuffle(SEARCH_APPROACHES).map((id) => [id, approachOption(game, a, h, id)])),
    };
  }
  if (searching) {
    questions.keep_hunting = {
      type: 'noul',
      instructions:
        'Is it still worth hunting the explorer? Judge from `last_seen` (how long ago, how far), `checked_cells_near_last_seen`, `approach_target` and `recent.progress`. ' +
        `Hunting stops anyway after ${maxSearchTicks} ticks without sight; giving up sends this adversary back to patrolling the dungeon, where it may run into the explorer again.`,
      criteria: {
        true: 'Keep hunting: the explorer was seen recently, and the approach still has a target worth reaching (unchecked space near the last-seen cell, or a cut-off point not reached yet).',
        false: 'Give up: the trail is cold. The explorer was seen long ago, the area around the last-seen cell is checked, or the cut-off point was reached and nothing came.',
      },
    };
  }
  if (!Object.keys(questions).length) return { legal, forced: legal[0] };
  const state = jevState(game, a, h, tick, rules(cfg));
  const body = JSON.stringify({ model: 'jev-latest', state, questions });
  return { legal, state, questions, body, options };
}

// One step's decision. Never throws: a failed call returns { error } and the caller falls back
// to the code move. -> { dir|null, decision, keep_hunting, approach, forced, apiMs, error }
// `ask` replaces the Jev call (the checks inject stubs); null = the real Jev.
export async function decide(game, a, tick, cfg, ask = null) {
  const h = a.hunt;
  const req = buildRequest(game, a, tick, cfg);
  if (!req.body) return { dir: req.forced, decision: null, keep_hunting: null, approach: null, forced: true, apiMs: 0, error: null };
  a.lastRequestBody = req.body;
  const started = performance.now();
  let answers;
  try {
    answers = await (ask ?? jevAsk)({ id: a.id, state: req.state, questions: req.questions, body: req.body });
  } catch (err) {
    return { dir: null, decision: null, keep_hunting: null, approach: null, forced: false, apiMs: Math.round(performance.now() - started), error: err.message ?? String(err) };
  }
  const apiMs = Math.round(performance.now() - started);
  let dir = req.legal.length === 1 ? req.legal[0] : null;
  let decision = null;
  if (req.questions.next_move) {
    const n = answers?.next_move;
    dir = req.legal.includes(n?.choice) ? n.choice : req.legal[0];
    decision = { choice: dir, probabilities: n?.probabilities ?? null, confidence: n?.confidence ?? null, options: req.options };
  }
  const approach = req.questions.search_approach && SEARCH_APPROACHES.includes(answers?.search_approach?.choice)
    ? answers.search_approach.choice
    : null;
  const keep = typeof answers?.keep_hunting?.noul === 'number' ? answers.keep_hunting.noul : null;
  return { dir, decision, keep_hunting: keep, approach, forced: !decision, apiMs, error: null, answers };
}

// Applies the parts of a decision that change memory (approach choice, latest action).
export function applyDecision(a, tick, res, { fallback = false } = {}) {
  const h = a.hunt;
  if (h.pickApproach && h.on && !h.inSight) {
    const id = res.approach ?? 'sweep_last_seen';
    const why = res.approach ? `lost sight of the explorer; Jev chose ${id}` : 'lost sight of the explorer; no Jev answer, sweeping by default';
    setApproach(h.memory, { id, text: APPROACHES[id].text }, why, tick);
    h.pickApproach = false;
  }
  if (res.dir) {
    recordAction(h.memory, { dir: res.dir, decision: res.decision, forced: res.forced, fallback });
    h.probabilities = res.decision?.probabilities ?? null;
  }
}

// The brain part of Run.view().adversaries[] (turn.js).
export function brainView(a) {
  const m = a.memory;
  const l = m.latest_action;
  return {
    on: m.brain.on,
    approach: m.approach.id,
    approach_text: m.approach.current,
    approach_since: m.approach.since_step,
    objective: m.objective,
    latest_action: l ? { choice: l.choice, probabilities: a.hunt.probabilities, confidence: l.confidence } : null,
    last_reason: m.brain.last_reason,
  };
}
