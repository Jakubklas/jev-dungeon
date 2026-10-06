// The brain: Jev decides, code observes (perception.js) and remembers (memory.js). Jev only
// ever sees known cells: the state is the rules sentence, the memory and perception's situation
// facts, never the dungeon itself. Adversaries reach Jev only while the explorer can see them
// (visibleAdversaries and perception's threats/encounter); brain.js never reads game.adversaries.
//
// Ordinary tick: ONE request (next_move, plus an approach review every few steps).
// Decision tick (an approach decision: encounter start, tactic failed, encounter over, chest
// spotted, review switch, game start): one extra request made first, in sequence:
//   request 1  `sentiment` (Choice). It sees memory, situation and the sentiment-free encounter
//              facts. The sentiment's code profile (SENTIMENTS) sets min_gap, which decides which
//              tactics are feasible, so the tactic can only be offered after it.
//   request 2  the normal tick request with the new sentiment in memory, plus `tactic` (Choice over
//              the feasible tactics, only while an adversary is in sight) and, speculatively, one
//              move question per tactic (`move_if_<tactic>`, judged with that tactic's move facts).
//              The move taken is the answer for the tactic Jev chose, so this tick's move already
//              follows the new tactic. With a single feasible tactic code takes it (no Choice).
import { EXPLORER_LIVES, applyMove, availableMoves, knownFloorCount } from '../../dungeon.js';
import {
  APPROACHES, TACTICS, approachTarget, availableApproaches, describeMoves, isTactic, situation, speedPhrase, tacticFeasibility, treasureSeen,
} from './perception.js';
import {
  addFinding, createMemory, interruptApproach, recordStep, replaceInterrupted, resumeApproach, saveMemory, setDanger, setSentiment, switchApproach,
} from './memory.js';
import { GRACE_TICKS, visibleAdversaries } from '../adversary/adversary.js';
import { askJev, shuffle } from '../../jev.js';

const REVIEW_EVERY = 8; // steps between approach reviews
const APPROACH_FAILING = 0.5; // approach_working.noul below this switches approach
const REDECIDE_COOLDOWN = 3; // min ticks between decision steps for a failing tactic
const MEMORY_DIR = new URL('../../../', import.meta.url); // dungeon-game/ (trailing slash matters)

// Sentiment profiles. Each one changes behaviour in code, not just a label:
//   min_gap    - the closest (in known-path steps) adversaries may come: decides which tactics are
//                feasible (perception.tacticFeasibility), tactic targets, and the "below your
//                minimum gap" warning in move descriptions; a tactic whose gap falls below it fails
//   end_ticks  - ticks with no adversary in sight before the encounter counts as over
//   priority   - a line injected into next_move's priorities
//   when       - what Jev reads when picking it (concrete circumstances)
export const SENTIMENTS = {
  scared: {
    min_gap: 5, end_ticks: 6,
    when: 'Pick when cornered: a chasing adversary within about 4 steps, in a corridor, dead end or small room (a side under 6), with no route past it whose closest approach is 3 or more.',
    priority: 'Scared: getting away comes first. Never move toward an adversary; take the move that leaves the most steps between you and avoid every dead end.',
    note: 'Flees first and never moves toward an adversary.',
  },
  risk_averse: {
    min_gap: 4, end_ticks: 5,
    when: 'Pick when an adversary is in sight 5 or more steps away but the ground is uncertain: few known exits, a corridor, or the best route past it comes within 3 steps.',
    priority: 'Risk-averse: keep at least 4 steps from adversaries; when in doubt take the move that grows the distance or keeps more exits open, even at the cost of progress.',
    note: 'Prefers retreat or hiding over passing.',
  },
  cautious: {
    min_gap: 3, end_ticks: 4,
    when: 'Pick when nothing is in sight (normal exploring), or the adversary is far (6+ steps) or still patrolling and has not reacted.',
    priority: 'Cautious: keep at least 3 steps from adversaries and favour well-connected ground with several exits over dead ends and long corridors.',
    note: 'Favours well-connected ground over dead ends and corridors.',
  },
  calculated: {
    min_gap: 3, end_ticks: 3,
    when: 'Pick when the facts show a clear plan: a known route past the adversary with a closest approach of 3 or more, a hiding cell reached safely, or an open room of 6×6 or more to dodge in.',
    priority: 'Calculated: follow the approach target exactly; among moves that keep at least 3 steps from adversaries, take the one that gets closest to the target.',
    note: 'Follows the computed route exactly.',
  },
  courageous: {
    min_gap: 2, end_ticks: 2,
    when: 'Pick when an adversary is in sight but there is room to work with: a big room with several exits, or a route past it toward unexplored space whose closest approach is only 2 steps.',
    priority: 'Courageous: hold your nerve. Keep at least 2 steps from adversaries, but do not give up ground just because one is in sight; keep making progress.',
    note: 'Holds its nerve and keeps making progress.',
  },
  aggressive: {
    min_gap: 2, end_ticks: 1,
    when: 'Pick when the goal is within reach: the chest is seen and its path keeps the adversary 2+ steps off, or the adversary is far (7+ steps) and progress matters most.',
    priority: 'Aggressive: push for the goal. Moving toward an adversary is fine while at least 2 steps stay between you; take the move that makes the most progress.',
    note: 'Pushes for the goal, moving toward adversaries when that gains ground.',
  },
};
const DEFAULT_SENTIMENT = 'cautious';
const profileNote = (id) => `min gap ${SENTIMENTS[id].min_gap}, encounter ends after ${SENTIMENTS[id].end_ticks} tick${SENTIMENTS[id].end_ticks === 1 ? '' : 's'} unseen. ${SENTIMENTS[id].note}`;
export const profileOf = (memory) => SENTIMENTS[memory.sentiment?.id] ?? SENTIMENTS[DEFAULT_SENTIMENT];

const TRIGGER_TEXT = {
  start: 'The explorer is about to start exploring the dark dungeon.',
  encounter: 'An adversary has just come into sight (or started chasing): the explorer must choose how to deal with it.',
  tactic_failed: 'The current tactic stopped working: its target is gone or the adversary got closer than the minimum gap.',
  chase_over: 'No adversary has been in sight for a while: the encounter is over and exploring resumes.',
  chest: 'The treasure chest has just been seen.',
  review: 'The explorer just dropped an exploration approach that was not working and switched to another.',
};

// How each tactic should shape the move while an adversary is in sight.
const TACTIC_MOVE_HINT = {
  run_away: 'Keep the distance growing and stay out of known dead ends.',
  slip_past: 'Moving toward or alongside it is fine while the gap stays at or above the minimum: follow the route past it to the approach target.',
  face_off: 'Stay in the open room and keep the gap; as it commits toward you, step around it, never into a corridor or dead end.',
  hide: 'Get to the approach target (out of its sight) quickly and do not step back into its line of sight.',
  race_to_chest: 'Head straight for the chest along the known path; getting there first matters most.',
  carry_on: 'It has not seen the explorer: keep exploring, preferring moves that stay out of its line of sight.',
};

const RULES =
  'A dungeon on a grid of walls and floor, explored one cell per step (up, down, left or right), or it can stand still (stay) and let a step pass. ' +
  'Every cell the explorer visits lights up the area around it for the rest of the game; lit cells are known, everything else is unknown. ' +
  'The treasure chest is somewhere in the unknown; the game is won by stepping onto it. ' +
  `Adversaries roam the dungeon. They move slower than the explorer (${speedPhrase()}), ` +
  'an adversary that sees the explorer chases it. An adversary that reaches the explorer\'s cell (or that the explorer steps onto) costs it one life; ' +
  `the explorer starts with ${EXPLORER_LIVES} lives (\`situation.lives\`) and the game is lost when the last one is gone. ` +
  `After a hit the adversary is knocked back and for the next ${GRACE_TICKS} steps no adversary can hurt the explorer (\`situation.hit_protection_steps\`). ` +
  'The explorer only knows about adversaries it can currently see. Meeting one does not have to mean running: ' +
  'with the speed edge the explorer can slip past, dodge in open rooms, hide, or race to a seen chest.';

const OBJECTIVE =
  'Find the treasure chest hidden in the dark dungeon and step onto it, in as few steps as possible: ' +
  'light up new territory, avoid walking back over explored ground, and go straight to the chest once it is seen.';

// memory -> { step, targetSteps }: when the approach was last reviewed (or started) and how far
// its target was then, so a review can tell travelling toward a far target from wandering.
const reviewInfo = new WeakMap();
// memory -> encounter bookkeeping: { unseen, ids (all seen), encIds (seen this encounter),
// modes (last seen mode per id), pending (a decision trigger waiting for the next tick), lastDecision }
const encounterInfo = new WeakMap();
// memory -> { id, cell }: the goal cell of the current tactic, kept so its target stays put.
const tacticGoals = new WeakMap();
let lastBodies = [];
let asker = null; // null = askJev; the check script stubs it (setAsker)

export function lastRequest() {
  return lastBodies.length ? JSON.parse(lastBodies.at(-1)) : null;
}
// Both bodies of the latest tick: [sentiment request, tick request] on a decision tick.
export function lastRequests() {
  return lastBodies.map((b) => JSON.parse(b));
}
export function setAsker(fn) {
  asker = fn;
}
// Where memory.json/memory.md go (the check script points this at a temp dir).
let memoryDir = MEMORY_DIR;
export function setMemoryDir(url) {
  memoryDir = url ?? MEMORY_DIR;
}

async function ask(kind, state, questions) {
  const body = JSON.stringify({ model: 'jev-latest', state, questions });
  lastBodies.push(body);
  const started = performance.now();
  const answers = asker ? await asker({ kind, state, questions, body }) : await askJev(state, questions, body);
  return { answers, ms: Math.round(performance.now() - started) };
}

const thoughtOf = (id) => APPROACHES[id]?.thought ?? 'Hmm, which way now?';
const approachOf = (id) => ({ id, text: APPROACHES[id].text, thought: APPROACHES[id].thought });

function infoOf(memory) {
  let info = encounterInfo.get(memory);
  if (!info) encounterInfo.set(memory, (info = { unseen: 0, ids: new Set(), encIds: new Set(), modes: new Map(), pending: null, lastDecision: -Infinity }));
  return info;
}

export function newRun(game) {
  const memory = createMemory({
    objective: OBJECTIVE,
    approachId: 'nearest_frontier',
    approachText: APPROACHES.nearest_frontier.text,
    thought: APPROACHES.nearest_frontier.thought,
    sentiment: { id: DEFAULT_SENTIMENT, profile_note: profileNote(DEFAULT_SENTIMENT) },
  });
  reviewInfo.set(memory, { step: 0, targetSteps: approachTarget(game, 'nearest_frontier')?.steps ?? null });
  memory.progress.known_floor_cells = knownFloorCount(game);
  infoOf(memory).pending = 'start';
  return memory;
}

export async function takeTurn(game, memory) {
  const step = game.steps + 1;
  const prev = game.steps;
  const info = infoOf(memory);
  lastBodies = [];
  let policy = spotTreasure(game, memory, prev); // guard: a flip we missed (e.g. the chest lit at the start)
  const sit = situation(game); // computed before the move: what Jev sees this tick
  const enc = encounterPolicy(game, memory, sit, prev, info);
  policy = enc.policy ?? policy;

  const legal = availableMoves(game);
  if (!legal.length) throw new Error('No legal moves');
  const forced = legal.length === 1;
  const inSight = sit.threats.length > 0;

  // A decision without an adversary in sight waits for the next tick with a real choice.
  let trigger = enc.trigger ?? info.pending;
  if (trigger && forced && !inSight) {
    info.pending = trigger;
    trigger = null;
  } else {
    info.pending = null;
  }

  let decision = null;
  let tacticIds = []; // feasible tactics Jev chooses between in request 2
  let decisionTargets = {}; // tactic id -> target cell at decision time
  let apiMs = 0;
  if (trigger) {
    info.lastDecision = step;
    const sentiment = await askSentiment(game, memory, sit, trigger);
    apiMs += sentiment.ms;
    const profile = profileOf(memory);
    decision = { trigger, sentiment: { choice: sentiment.choice, probabilities: sentiment.probabilities }, tactic: null, apiMs: sentiment.ms };
    if (inSight) {
      const feasible = tacticFeasibility(game, profile.min_gap);
      decisionTargets = Object.fromEntries(Object.entries(feasible).map(([id, f]) => [id, f.target.cell]));
      const options = Object.fromEntries(TACTICS.filter((id) => feasible[id]).map((id) => [id, `${APPROACHES[id].text} ${feasible[id].fact}`]));
      tacticIds = Object.keys(options);
      if (tacticIds.length === 1) {
        // Only one way to deal with it: code takes it, no one-option Choice.
        applyTactic(game, memory, tacticIds[0], trigger, prev, decisionTargets[tacticIds[0]]);
        decision.tactic = { choice: tacticIds[0], probabilities: { [tacticIds[0]]: 1 }, options };
        tacticIds = [];
      } else if (tacticIds.length) {
        decision.tactic = { choice: null, probabilities: null, options };
      }
    }
  }

  const profile = profileOf(memory);
  const questions = {};
  let moveOptions = {}; // per approach id: the shuffled move criteria
  if (tacticIds.length) {
    questions.tactic = {
      type: 'choice',
      instructions: {
        question:
          `${TRIGGER_TEXT[trigger]} Which tactic should the explorer use now? It feels ${memory.sentiment.id} (\`memory.sentiment\`), ` +
          `so adversaries must stay at least ${profile.min_gap} steps away; only tactics that allow that are listed. ` +
          'Judge from `situation.encounter` (space, gap, speed, routes) and `situation.threats`.',
        priorities: [
          profile.priority,
          'If the chest is seen and a listed tactic reaches it safely, prefer it.',
          'Prefer a tactic that keeps making progress (slipping past, carrying on, dodging) over running away when the facts show a safe gap.',
          'Running away is for when the adversary is close, the space is cramped, or no other listed tactic is safe.',
        ],
      },
      criteria: Object.fromEntries(shuffle(tacticIds).map((id) => [id, decision.tactic.options[id]])),
    };
    if (!forced) {
      for (const id of tacticIds) {
        const q = moveQuestion(game, id, sit, memory, profile, true);
        questions[`move_if_${id}`] = q.question;
        moveOptions[id] = q.options;
      }
    }
  } else if (!forced) {
    const q = moveQuestion(game, memory.approach.id, sit, memory, profile, false);
    questions.next_move = q.question;
    moveOptions[memory.approach.id] = q.options;
  }

  const approachId = memory.approach.id;
  const rInfo = reviewInfo.get(memory) ?? { step: 0, targetSteps: null };
  const sinceReview = step - rInfo.step;
  // No reviews while a tactic or the chest run is on: those last as long as the situation does.
  const reviewDue =
    !forced && !tacticIds.length && approachId !== 'go_to_treasure' && !isTactic(approachId) &&
    sinceReview >= REVIEW_EVERY && memory.progress.steps_since_approach >= REVIEW_EVERY;
  if (reviewDue) addReviewQuestions(game, memory, questions, approachId, rInfo);

  let dir = legal[0];
  let moveDecision = null;
  let review = null;
  let pendingSwitch = null;
  if (Object.keys(questions).length) {
    const state = { game: RULES, memory, situation: sit };
    const res = await ask('tick', state, questions);
    apiMs += res.ms;
    const answers = res.answers;

    let moveKey = 'next_move';
    let moveFor = memory.approach.id;
    if (tacticIds.length) {
      const c = answers.tactic?.choice;
      const chosen = tacticIds.includes(c) ? c : tacticIds.includes('run_away') ? 'run_away' : tacticIds[0];
      decision.tactic = { choice: chosen, probabilities: answers.tactic?.probabilities ?? null, options: decision.tactic.options };
      applyTactic(game, memory, chosen, trigger, prev, decisionTargets[chosen]);
      moveKey = `move_if_${chosen}`;
      moveFor = chosen;
    }
    const a = answers[moveKey];
    if (!forced && a) {
      dir = legal.includes(a.choice) ? a.choice : legal[0];
      moveDecision = { choice: dir, probabilities: a.probabilities, confidence: a.confidence, options: moveOptions[moveFor] };
    }

    if (reviewDue && answers.approach_working) {
      reviewInfo.set(memory, { step, targetSteps: approachTarget(game, approachId)?.steps ?? null });
      const working = answers.approach_working.noul;
      review = { working, switched: false, from: approachId, to: approachId, reason: null };
      if (working < APPROACH_FAILING && answers.next_approach && APPROACHES[answers.next_approach.choice] && !isTactic(answers.next_approach.choice)) {
        const p = memory.progress;
        const reason =
          `Jev judged it not working (${Math.round(working * 100)}%): ${p.revealed_since_approach} cells revealed in ` +
          `${p.steps_since_approach} steps, ${p.revisits_last_10} revisits in the last 10.`;
        pendingSwitch = { id: answers.next_approach.choice, reason };
        review = { ...review, switched: true, to: pendingSwitch.id, reason };
      }
    }
  }
  if (decision) decision.apiMs = apiMs; // the whole decision tick: sentiment + tick request

  const result = applyMove(game, dir);
  recordStep(memory, {
    step: game.steps,
    dir,
    revealed: result.revealed,
    revisit: result.revisit,
    known_floor_cells: knownFloorCount(game),
    decision: moveDecision,
    forced: moveDecision === null,
  });
  // The chest outranks any review outcome: once seen, go straight to it.
  const chest = result.won ? null : spotTreasure(game, memory, game.steps);
  if (chest) policy = chest;
  else if (pendingSwitch && !result.won && !isTactic(memory.approach.id)) {
    switchApproach(memory, approachOf(pendingSwitch.id), pendingSwitch.reason, game.steps);
    reviewInfo.set(memory, { step: game.steps, targetSteps: approachTarget(game, pendingSwitch.id)?.steps ?? null });
    info.pending = info.pending ?? 'review'; // the new approach gets its sentiment next tick
  }
  if (result.won) addFinding(memory, `Stepped onto the treasure chest at step ${game.steps}.`, game.steps);
  await saveMemory(memory, memoryDir);

  return {
    step: game.steps, dir, forced: moveDecision === null, revealed: result.revealed, won: result.won,
    move_decision: moveDecision, decision, review, policy, apiMs,
  };
}

// Records a catch (called by turn.js after the adversaries moved) and saves.
export async function noteCaught(game, memory, adversaryId) {
  addFinding(memory, `Caught by adversary ${adversaryId} at step ${game.steps}.`, Math.max(game.steps, 1));
  await saveMemory(memory, memoryDir);
}

// Records a hit that cost a life but did not end the game (called by turn.js) and saves.
export async function noteHit(game, memory, adversaryId) {
  addFinding(memory, `Hit by adversary ${adversaryId} at step ${game.steps}: ${game.health} of ${game.maxHealth} lives left.`, Math.max(game.steps, 1));
  await saveMemory(memory, memoryDir);
}

// Request 1 of a decision step. Sets memory.sentiment and returns { choice, probabilities, ms }.
async function askSentiment(game, memory, sit, trigger) {
  const ids = Object.keys(SENTIMENTS);
  const inSight = sit.threats.length > 0;
  // With an adversary in sight, each mood also says which tactics its minimum gap leaves open here.
  const allowed = new Map();
  if (inSight) {
    for (const g of new Set(ids.map((id) => SENTIMENTS[id].min_gap))) {
      allowed.set(g, Object.keys(tacticFeasibility(game, g)).map((id) => id.replace(/_/g, ' ')));
    }
  }
  const criteria = Object.fromEntries(shuffle(ids).map((id) => {
    const s = SENTIMENTS[id];
    const here = inSight ? ` Here and now its ${s.min_gap}-step minimum gap leaves: ${allowed.get(s.min_gap).join(', ') || 'nothing but luck'}.` : '';
    return [id, `${s.when} Effect: ${profileNote(id)}${here}`];
  }));
  const questions = {
    sentiment: {
      type: 'choice',
      instructions:
        `${TRIGGER_TEXT[trigger]} How should the explorer feel about it right now? The mood is not a label: it sets how close ` +
        'adversaries may come (minimum gap), how long the explorer stays wary after losing sight of them, and how boldly it moves. ' +
        'Judge from the circumstances: `situation.here`, `situation.threats` and `situation.encounter` (room size, gap, adversary speed, ' +
        'best route past it, nearest hiding cell, dead ends, chest), and `memory` (findings, danger, recent sentiments). ' +
        'Pick the mood the circumstances call for, not the previous one by habit.',
      criteria,
    },
  };
  const state = { game: RULES, memory, situation: sit };
  const { answers, ms } = await ask('sentiment', state, questions);
  const a = answers.sentiment;
  const choice = SENTIMENTS[a?.choice] ? a.choice : memory.sentiment.id;
  setSentiment(memory, { id: choice, profile_note: profileNote(choice) }, game.steps + 1);
  return { choice, probabilities: a?.probabilities ?? null, ms };
}

// next_move for one approach. speculative: asked once per tactic on a decision tick.
function moveQuestion(game, approachId, sit, memory, profile, speculative) {
  const moves = describeMoves(game, approachId, { minGap: profile.min_gap, goal: speculative ? null : goalOf(memory) });
  // Option order is shuffled every tick because Jev leans toward the first option.
  const options = Object.fromEntries(shuffle(availableMoves(game)).map((d) => [d, moves[d]]));
  const gap = profile.min_gap;
  const question = speculative
    ? `Suppose the explorer takes the "${approachId}" tactic: ${APPROACHES[approachId].text} Which way should it step next? It feels ${memory.sentiment.id} (\`memory.sentiment\`). Judge each move from its description and \`situation\`.`
    : 'Which way should the explorer step next to achieve `memory.objective`, following `memory.approach.current`? ' +
      `It feels ${memory.sentiment.id} (\`memory.sentiment\`). Judge each move from its description, \`situation\` and \`memory.progress\`.`;
  return {
    options,
    question: {
      type: 'choice',
      instructions: {
        question,
        priorities: [
          // While getting away or hiding, "head for the chest" must not outrank safety.
          approachId === 'run_away' || approachId === 'hide'
            ? 'If a move steps onto the treasure chest, take it.'
            : 'If a move steps onto the treasure chest, take it. If the chest has been seen, move closer to it along the known path.',
          ...(sit.threats.length
            ? [
                `An adversary is in sight (\`situation.threats\`, \`situation.encounter\`). Never step into it, and avoid moves that leave fewer than ${gap} steps between you (marked "below your minimum gap"). ` +
                  (TACTIC_MOVE_HINT[approachId] ?? 'Never step into a known dead end where the explorer can be cornered, and keep the distance growing.'),
              ]
            : []),
          profile.priority,
          'Standing still (stay) makes no progress and lets adversaries close in: pick it only when every step is worse, for example when each step would walk into danger.',
          'Follow the approach: prefer the move that brings the explorer closer to the approach target.',
          'Prefer moves that reveal many new cells and moves onto never-visited cells over moves onto cells already visited.',
          'Avoid backtracking: do not step into a known dead end with nothing left to explore, and avoid undoing the previous move unless every other way is explored. `memory.latest_action` is the previous move and `memory.progress.revisits_last_10` shows how much the explorer has been going in circles.',
        ],
      },
      criteria: options,
    },
  };
}

function addReviewQuestions(game, memory, questions, approachId, info) {
  const target = approachTarget(game, approachId);
  const travel = !target
    ? ' The approach has no target left: no reachable edge of the known map.'
    : info.targetSteps === null
      ? ` Its target is now ${target.steps} known-path steps away.`
      : ` Its target is now ${target.steps} known-path steps away (it was ${info.targetSteps} at the last check).`;
  questions.approach_working = {
    type: 'noul',
    instructions:
      'Since `memory.approach.since_step`, is `memory.approach.current` making real progress toward `memory.objective`? Judge from `memory.progress` (cells revealed and steps taken since the approach started, recent revisits) and `situation`.' +
      travel +
      ' Walking over visited cells is fine while the target keeps getting closer; switching approach mid-journey usually means turning back.',
    criteria: {
      true: 'Progress: new territory is being lit up steadily, or the explorer is still crossing known ground on a direct route toward unexplored space (an approach that travels far needs a few steps before it reveals anything).',
      false: 'Stuck: going back and forth, circling through explored ground, or revisiting cells many times while revealing almost nothing.',
    },
  };
  const alternatives = availableApproaches(game).filter((id) => id !== approachId && id !== 'go_to_treasure');
  if (alternatives.length) {
    questions.next_approach = {
      type: 'choice',
      instructions:
        'If `memory.approach.current` were dropped, which approach should the explorer try next to achieve `memory.objective`? Avoid approaches in `memory.approach.tried` that already failed, and use `situation.unexplored_by_direction`.',
      criteria: Object.fromEntries(shuffle(alternatives).map((id) => [id, approachOption(game, id)])),
    };
  }
}

// Starts tactic `id` (parking the exploration approach; a tactic-to-tactic switch keeps the parked
// one). Tactics never go into `tried`. Re-picking the current tactic changes nothing.
function applyTactic(game, memory, id, trigger, prev, cell) {
  if (cell) tacticGoals.set(memory, { id, cell });
  if (memory.approach.id === id) return;
  interruptApproach(memory, approachOf(id), trigger === 'encounter' ? 'met an adversary' : `encounter: ${trigger.replace(/_/g, ' ')}`, prev);
  reviewInfo.set(memory, { step: prev + 1, targetSteps: null });
}

// Encounter bookkeeping, run at the start of every tick from what the explorer sees now (after
// the adversaries' last moves). Returns { trigger, policy }:
//   - an adversary comes into sight with no tactic on, a new one appears during the encounter,
//     or a visible one switches patrol -> chase: trigger 'encounter'
//   - the current tactic's target is gone, or (except run_away) the gap fell below the
//     sentiment's min_gap: trigger 'tactic_failed' (at most every REDECIDE_COOLDOWN ticks)
//   - the sentiment's end_ticks with nothing in sight: the encounter is over, the parked approach
//     resumes (policy) and trigger 'chase_over'
function encounterPolicy(game, memory, sit, prev, info) {
  const visible = visibleAdversaries(game);
  const at = Math.max(prev, 1);
  const step = prev + 1;
  const profile = profileOf(memory);
  const a = memory.approach;

  // situation.threats is built from visibleAdversaries in the same order, so index i matches.
  const threats = sit.threats ?? [];
  visible.forEach((v, i) => {
    if (info.ids.has(v.id)) return;
    info.ids.add(v.id);
    memory.danger.adversaries_seen = info.ids.size;
    const th = threats.length === visible.length ? threats[i] : null;
    const n = th?.distance ?? Math.round(v.distance);
    addFinding(memory, `Spotted an adversary to the ${th?.direction ?? 'side'}, ${n} step${n === 1 ? '' : 's'} away (step ${at}).`, at);
  });

  if (visible.length) info.unseen = 0;
  else info.unseen += 1;
  if (visible.some((v) => v.mode === 'chase') && memory.danger.status !== 'chased') setDanger(memory, 'chased', at);

  let trigger = null;
  let policy = null;
  const inEncounter = isTactic(a.id);
  if (visible.length) {
    const newcomer = visible.some((v) => !info.encIds.has(v.id));
    const turned = visible.some((v) => v.mode === 'chase' && info.modes.get(v.id) === 'patrol');
    // (Without a tactic on, e.g. no tactic was feasible last time, retry only after the cooldown.)
    if (newcomer || turned || (!inEncounter && step - info.lastDecision >= REDECIDE_COOLDOWN)) trigger = 'encounter';
    else if (step - info.lastDecision >= REDECIDE_COOLDOWN && tacticFailing(game, memory, profile, sit)) trigger = 'tactic_failed';
    for (const v of visible) {
      info.encIds.add(v.id);
      info.modes.set(v.id, v.mode);
    }
  } else if (inEncounter && info.unseen >= profile.end_ticks) {
    if (memory.danger.status === 'chased') setDanger(memory, 'safe', at);
    addFinding(memory, `Got away: no adversary in sight for ${info.unseen} tick${info.unseen === 1 ? '' : 's'} (step ${at}).`, at);
    const from = a.id;
    if (!resumeApproach(memory, prev, thoughtOf)) {
      interruptApproach(memory, approachOf('nearest_frontier'), 'encounter over', prev);
      a.interrupted = null;
    }
    reviewInfo.set(memory, { step: at, targetSteps: approachTarget(game, a.id)?.steps ?? null });
    policy = { from, to: a.id, reason: `no adversary in sight for ${info.unseen} tick${info.unseen === 1 ? '' : 's'}` };
    trigger = 'chase_over';
    info.encIds = new Set();
    info.modes = new Map();
  }
  return { trigger, policy };
}

// The kept goal of the current tactic (null when it belongs to another tactic).
function goalOf(memory) {
  const g = tacticGoals.get(memory);
  return g && g.id === memory.approach.id ? g.cell : null;
}

function tacticFailing(game, memory, profile, sit) {
  const id = memory.approach.id;
  const target = approachTarget(game, id, { minGap: profile.min_gap, goal: goalOf(memory) });
  if (target) tacticGoals.set(memory, { id, cell: target.cell });
  if (!target) return true;
  return id !== 'run_away' && sit.encounter && sit.encounter.gap_now < profile.min_gap;
}

// An approach option for Jev: what it means plus where it would lead from here (known cells only).
function approachOption(game, id) {
  const t = approachTarget(game, id);
  return `${APPROACHES[id].text} ${t ? t.why : 'No reachable target from here.'}`;
}

// Code policy: as soon as the chest is known, record it and make go_to_treasure the approach (or,
// mid-encounter, the approach to resume). Queues a decision step. Returns the policy switch or null.
function spotTreasure(game, memory, step) {
  const a = memory.approach;
  if (a.id === 'go_to_treasure' || a.id === 'race_to_chest' || a.interrupted?.id === 'go_to_treasure' || game.won || !treasureSeen(game)) return null;
  const target = approachTarget(game, 'go_to_treasure');
  const at = Math.max(step, 1);
  addFinding(memory, target ? `Spotted the treasure chest ${target.steps} steps away.` : 'Spotted the treasure chest.', at);
  infoOf(memory).pending = 'chest';
  if (isTactic(a.id)) {
    // Mid-encounter: the chest becomes the approach to resume, and the decision step can pick race_to_chest.
    replaceInterrupted(memory, { id: 'go_to_treasure', text: APPROACHES.go_to_treasure.text }, 'chest spotted', at);
    return null;
  }
  const from = a.id;
  switchApproach(memory, approachOf('go_to_treasure'), 'chest spotted', at);
  reviewInfo.set(memory, { step: at, targetSteps: target?.steps ?? null });
  return { from, to: 'go_to_treasure', reason: 'chest spotted' };
}
