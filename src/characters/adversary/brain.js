// An adversary's brain: one Jev request per adversary step while the brain is on.
// Code observes (perception.js), Jev decides, memory.js remembers. adversary.js runs the
// on/off state machine and calls decide() for every brain-on adversary with a step this tick,
// all in parallel.
//
// FOG: the explorer's position reaches Jev only while hunt.inSight (seesExplorer) is true.
// Out of sight, Jev gets last_seen only. Never the treasure, never the explorer's light/visits.
// lastRequest(id) keeps the exact body sent per adversary, for auditing.
//
// Code policies (no Jev): switch on at startsChase, direct_pursuit while in sight, take a move
// that catches the explorer, take the only legal move, switch off after MAX_SEARCH_TICKS.
// Jev decides: every other move, cut_off vs sweep_last_seen on the first search step, and
// keep_hunting on every search step.
import { DIRS, floorDistances } from '../../dungeon.js';
import { APPROACHES, SEARCH_APPROACHES, adversaryMoves, approachOption, compass8, describeMoves, situation, stepCell, sweep } from './perception.js';
import { addFinding, brainOff, brainOn, createMemory, recordAction, setApproach } from './memory.js';
import { askJev, shuffle } from '../../jev.js';

export const KEEP_HUNTING_MIN = 0.5; // keep_hunting.noul below this switches the brain off

const key = ([x, y]) => `${x},${y}`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

function rules(speed, maxSearchTicks) {
  return (
    'A dungeon on a grid of walls and floor. You are one of several adversaries hunting an explorer who is looking for a hidden treasure chest. ' +
    `You move one cell per step (up, down, left or right) at ${Math.round(speed * 100)}% of the explorer's speed, so you cannot outrun it in a straight race. ` +
    'You know the whole map. You see the explorer only with a clear line of sight within 7 cells; out of sight you only know where and when you last saw it and which way it was heading. ' +
    'You catch the explorer by stepping onto its cell. Adversaries may share a cell. ' +
    `If you stop hunting, or go ${maxSearchTicks} ticks without seeing the explorer, you go back to patrolling.`
  );
}

// adversary -> hunt state. Kept off the Adversary object so its contracted shape stays the same.
//   on, inSight (seesExplorer this tick), heading (explorer's last move when last seen, frozen out of
//   sight), ticksSinceSeen, swept (cells checked since sight was lost), cutOff (cached cut-off point),
//   dists (recent path distances while in sight), trend (frozen distance trend), pickApproach, memory
const hunts = new WeakMap();
const requests = new Map(); // adversary id -> last body string
let decider = null; // null = askJev

export function huntOf(a) {
  let h = hunts.get(a);
  if (!h) {
    h = { on: false, inSight: false, heading: null, ticksSinceSeen: 0, swept: new Set(), cutOff: null, dists: [], trend: null, pickApproach: false, memory: createMemory(a.id) };
    hunts.set(a, h);
  }
  return h;
}

// Test hook: fn({ id, state, questions, body }) -> answers (same shape as askJev). null restores Jev.
export function setDecider(fn) {
  decider = fn;
}

export function lastRequest(id) {
  const body = requests.get(id);
  return body === undefined ? null : JSON.parse(body);
}
export function lastRequestBody(id) {
  return requests.get(id) ?? null;
}
export function resetRequests() {
  requests.clear();
}

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
  const h = huntOf(a);
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
  m.progress.ticks_since_seen = 0;
  m.progress.distance_trend = trendText(h.dists);
  setApproach(m, { id: 'direct_pursuit', text: APPROACHES.direct_pursuit.text }, 'the explorer is in sight again', tick);
}

export function switchOn(game, a, tick) {
  const h = huntOf(a);
  h.on = true;
  h.dists = [];
  const n = Math.round(Math.hypot(game.pos[0] - a.pos[0], game.pos[1] - a.pos[1]));
  brainOn(h.memory, tick, 'spotted the explorer');
  addFinding(h.memory, `Spotted the explorer to the ${compass8(a.pos, game.pos)}, about ${n} cells away (tick ${tick}).`, tick);
  seen(game, a, tick, { startOfTick: true });
}

// Sight lost: the next step picks a search approach.
export function lostSight(game, a, tick) {
  const h = huntOf(a);
  h.inSight = false;
  h.trend = h.memory.progress.distance_trend;
  h.pickApproach = true;
  h.cutOff = null;
  sweepFrom(game, a);
  addFinding(h.memory, `Lost sight of the explorer at tick ${tick}${h.heading ? `, heading ${h.heading}` : ''}.`, tick);
}

// Once per tick while searching.
export function searchTick(a) {
  const h = huntOf(a);
  h.inSight = false;
  h.ticksSinceSeen += 1;
  h.memory.progress.ticks_since_seen = h.ticksSinceSeen;
  h.memory.progress.distance_trend = `out of sight for ${h.ticksSinceSeen} tick${h.ticksSinceSeen === 1 ? '' : 's'}; before that ${h.trend ?? 'unknown'}`.slice(0, 160);
}

export function hunted(a) {
  huntOf(a).memory.progress.ticks_hunting += 1;
}

// Marks what this adversary sees from its cell as checked (search mode only).
export function sweepFrom(game, a) {
  sweep(game.dungeon, huntOf(a), a.pos);
}

export function switchOff(a, tick, reason) {
  const h = huntOf(a);
  h.on = false;
  h.inSight = false;
  h.swept.clear();
  h.cutOff = null;
  h.dists = [];
  h.pickApproach = false;
  h.ticksSinceSeen = 0;
  brainOff(h.memory, tick, reason);
  addFinding(h.memory, `Stopped hunting at tick ${tick}: ${reason}`, tick);
}

// --- the decision -------------------------------------------------------------------------

// Builds the request for one step. Pure: no state changes. Returns { legal, forced } when no
// Jev call is needed (code policy), else { legal, state, questions, body, options }.
export function buildRequest(game, a, tick, { speed, maxSearchTicks }) {
  const h = huntOf(a);
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
    const moves = describeMoves(game, a, h, approachIds);
    options = Object.fromEntries(shuffle(legal).map((d) => [d, moves[d]]));
    const priorities = searching
      ? [
          h.pickApproach
            ? 'The explorer was just lost from sight and the search approach is being chosen this step (`search_approach`): prefer the move that serves the better search approach, starting from the path to the last-seen cell.'
            : 'Follow `memory.approach.current`: prefer the move that brings this adversary closer to `situation.approach_target`.',
          'Prefer moves that bring unchecked cells into view over moves that bring nothing new into view.',
          'Avoid undoing the previous move (`memory.latest_action`) unless the target lies behind.',
          'Standing in a corridor, doorway or junction the explorer must pass is better than open room floor.',
        ]
      : [
          'Close the path distance to the explorer (`situation.explorer.path_steps`): prefer moves whose path distance goes down.',
          'Among moves that close in equally, prefer one that keeps the explorer in sight, then one that blocks a corridor, doorway or junction ahead of it (`situation.explorer.heading`).',
        ];
    questions.next_move = {
      type: 'choice',
      instructions: {
        question: searching && h.pickApproach
          ? 'The explorer just went out of sight. Which way should this adversary step next to achieve `memory.objective`, starting the search from `situation.last_seen`? Judge each move from its description, `situation` and `memory.progress`.'
          : 'Which way should this adversary step next to achieve `memory.objective`, following `memory.approach.current`? Judge each move from its description, `situation` and `memory.progress`.',
        priorities,
      },
      criteria: options,
    };
  }
  if (searching && h.pickApproach) {
    questions.search_approach = {
      type: 'choice',
      instructions:
        'The explorer just went out of sight (`situation.last_seen`). Which search approach gives this adversary the best chance to catch it? Use `situation.last_seen.heading`, the map facts and how far each target is.',
      criteria: Object.fromEntries(shuffle(SEARCH_APPROACHES).map((id) => [id, approachOption(game, a, h, id)])),
    };
  }
  if (searching) {
    questions.keep_hunting = {
      type: 'noul',
      instructions:
        'Is it still worth hunting the explorer? Judge from `situation.last_seen` (how long ago, how far), `situation.checked_cells_near_last_seen`, `situation.approach_target` and `memory.progress`. ' +
        `Hunting stops anyway after ${maxSearchTicks} ticks without sight; giving up sends this adversary back to patrolling the dungeon, where it may run into the explorer again.`,
      criteria: {
        true: 'Keep hunting: the explorer was seen recently, and the approach still has a target worth reaching (unchecked space near the last-seen cell, or a cut-off point not reached yet).',
        false: 'Give up: the trail is cold. The explorer was seen long ago, the area around the last-seen cell is checked, or the cut-off point was reached and nothing came.',
      },
    };
  }
  if (!Object.keys(questions).length) return { legal, forced: legal[0] };
  const state = { game: rules(speed, maxSearchTicks), memory: h.memory, situation: situation(game, a, h, tick) };
  const body = JSON.stringify({ model: 'jev-latest', state, questions });
  return { legal, state, questions, body, options };
}

// One step's decision. Never throws: a failed call returns { error } and the caller falls back
// to the code move. -> { dir|null, decision, keep_hunting, approach, forced, apiMs, error }
export async function decide(game, a, tick, cfg) {
  const h = huntOf(a);
  const req = buildRequest(game, a, tick, cfg);
  if (!req.body) return { dir: req.forced, decision: null, keep_hunting: null, approach: null, forced: true, apiMs: 0, error: null };
  requests.set(a.id, req.body);
  const started = performance.now();
  let answers;
  try {
    answers = decider
      ? await decider({ id: a.id, state: req.state, questions: req.questions, body: req.body })
      : await askJev(req.state, req.questions, req.body);
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
  const h = huntOf(a);
  if (h.pickApproach && h.on && !h.inSight) {
    const id = res.approach ?? 'sweep_last_seen';
    const why = res.approach ? `lost sight of the explorer; Jev chose ${id}` : 'lost sight of the explorer; no Jev answer, sweeping by default';
    setApproach(h.memory, { id, text: APPROACHES[id].text }, why, tick);
    h.pickApproach = false;
  }
  if (res.dir) recordAction(h.memory, { dir: res.dir, decision: res.decision, forced: res.forced, fallback });
}

export function memoryOf(a) {
  return huntOf(a).memory;
}

// The brain part of view(game).adversaries[].
export function brainView(a) {
  const m = huntOf(a).memory;
  const l = m.latest_action;
  return {
    on: m.brain.on,
    approach: m.approach.id,
    approach_text: m.approach.current,
    approach_since: m.approach.since_step,
    objective: m.objective,
    latest_action: l ? { choice: l.choice, probabilities: l.probabilities, confidence: l.confidence } : null,
    last_reason: m.brain.last_reason,
  };
}
