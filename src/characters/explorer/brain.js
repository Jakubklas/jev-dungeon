// The brain: ExplorerBrain. Jev decides, code observes (perception.js) and remembers (memory.js). Jev only
// ever sees known cells: the state is { game, self, surroundings, threats, plan, recent } (the rules
// sentence, perception's facts and the persistent memory), never the dungeon itself. Adversaries
// reach Jev only while the explorer can see them (KnownWorld.visibleAdversaries and perception's
// threats.visible/encounter) or as a frozen sighting (threats.remembered): the brain keeps what it
// SAW, at the cell where it saw it, and only ever moves that record by its own position and known
// line of sight. It never reads an adversary that is out of sight.
//
// Ordinary tick: ONE request (next_move, plus an approach review every few steps).
// Decision tick (an approach decision: encounter start, tactic failed, encounter over, portal
// spotted, review switch, game start): one extra request made first, in sequence:
//   request 1  `sentiment` (Choice). It sees memory, situation and the sentiment-free encounter
//              facts. The sentiment's code profile (SENTIMENTS) sets min_gap, which decides which
//              tactics are feasible, so the tactic can only be offered after it.
//   request 2  the normal tick request with the new sentiment in memory, plus `tactic` (Choice over
//              the feasible tactics, only while an adversary is in sight) and, speculatively, one
//              move question per tactic (`move_if_<tactic>`, judged with that tactic's move facts).
//              The move taken is the answer for the tactic Jev chose, so this tick's move already
//              follows the new tactic. With a single feasible tactic code takes it (no Choice).
import { EXPLORER_LIVES, SIGHT_RANGE, STAY } from '../../dungeon.js';
import {
  APPROACHES, TACTICS, approachTarget, availableApproaches, avoidZone, describeMoveParts, exitSeen, isTactic, leaveFacts, nearbyPiles, situation, tacticFeasibility,
} from './perception.js';
import { dirWord, euclid, isFrontier, key, knownDistances, knownFloor, neighbours, sameCell } from './known-map.js';
import { knownLineOfSight, speedPhrase, threatDistance, threatsOf } from './encounter.js';
import { buildSkillSet, skillConfig } from '../../skills/loadouts.js';
import { pickSkill, skillQuestion } from '../../skills/question.js';
import {
  LIMITS, addEvent, addLandmark, backAndForth, changeApproach, countEncounter, createMemory, interruptApproach, recordStep, replaceInterrupted, resumeApproach, saveMemory, setSentiment, setSkills, switchApproach,
} from './memory.js';
import { GRACE_TICKS } from '../adversary/adversary.js';
import { PRESSED_RANGE, apply as applyConfidence, band as confidenceBand, closeEncounter, createConfidence, engageOpen, gaps as confidenceGaps, seeChase } from './confidence.js';
import { askJev, shuffle } from '../../jev.js';

const REVIEW_EVERY = 8; // steps between approach reviews
const APPROACH_FAILING = 0.5; // approach_working.noul below this switches approach
const REDECIDE_COOLDOWN = 3; // min ticks between decision steps for a failing tactic
const REMEMBER_STEPS = 30; // a remembered sighting expires after this many steps
const SKILL_NEAR = 10; // loose gate (PLAN D7): an opponent visible, or remembered fresh, within this many cells
const SKILL_REMEMBER_STEPS = 10; // a sighting this young still opens the gate
const THREAT_STEPS = 2; // a visible chaser within this many path steps offers the block
// Ghosts get their claw attack in a later phase (PLAN S4). Until then a block has nothing to stop; the
// plan wants it left out, but this phase offers it anyway. Flip to false to hide the block option.
const GHOSTS_CAN_ATTACK = true;
const HOLD_MAX = 5; // engage hold: consecutive ticks the explorer waits 2 steps off a hunting ghost before the normal question returns
const HOLD_ADJACENT_MAX = 2; // ... and ticks it stays beside one without striking (a skill pick below SKILL_MIN)
const PINGPONG_FAILS = 3; // back-and-forth moves under a tactic that make it fail
const MEMORY_DIR = new URL('../../../', import.meta.url); // dungeon-game/ (trailing slash matters)

// The real Jev call; a Run or a check passes `ask` to replace it.
const askReal = ({ state, questions, body }) => askJev(state, questions, body);

// Sentiment profiles. Each one changes behaviour in code, not just a label:
//   min_gap    - the closest (in known-path steps) adversaries may come: decides which tactics are
//                feasible (perception.tacticFeasibility), tactic targets, and the "below your
//                minimum gap" warning in move descriptions; a tactic whose gap falls below it fails
//   end_ticks  - ticks with no adversary in sight before the encounter counts as over
//   priority   - a line injected into next_move's priorities and the tactic question
//   move_priority - the same rule, shortened, for the one-per-tactic move questions
//   when       - what Jev reads when picking it (concrete circumstances)
//   skill_priority - the mind's rule for skills: in the `skill` question and, while a skill is offered, next_move's priorities
export const SENTIMENTS = {
  wary: {
    min_gap: 4, end_ticks: 5,
    move_priority: 'Wary: never move toward an adversary; grow the distance, keep exits open, avoid dead ends.',
    when: 'Upside: gets you out alive. Risk: gives up coins and progress. Pick when outnumbered (2+ adversaries in sight or remembered), or a chaser is within 3 steps with no route past it, or only 1 life is left.',
    priority: 'Wary: getting away comes first. Never move toward an adversary; keep at least 4 steps from them, take the move that leaves the most steps between you, keep several exits open and avoid dead ends. Leave by the portal only if leaving is already worth it.',
    note: 'Gets away first: runs, hides, never moves toward an adversary.',
    skill_priority: 'Strike an adjacent adversary whenever the sword is ready (the stun buys distance); block when none is adjacent but one can reach you.',
  },
  steady: {
    min_gap: 3, end_ticks: 4,
    move_priority: 'Steady: follow the plan; favour well-connected ground over dead ends.',
    when: 'Upside: no wasted risk or detours. Risk: misses loot and fights. Pick when no adversary is in sight and nothing else clearly fits (a plan to follow, no coins in sight, little left to explore nearby), or when exactly one is in sight and fighting it is clearly bad (sword not ready, or fewer than full lives and no hit protection). Never with 2+ adversaries known: that is wary.',
    priority: 'Steady: follow the plan: explore, take coins that lie on the way, keep at least 3 steps from adversaries and favour well-connected ground with several exits over dead ends and long corridors.',
    note: 'Sticks to the plan: explores, coins on the way, keeps a safe distance.',
    skill_priority: 'Strike an adjacent adversary whenever the sword is ready; else block if one can reach you.',
  },
  greedy: {
    min_gap: 3, end_ticks: 2,
    move_priority: 'Greedy: prefer coins, then the move revealing the most new cells; detours are fine.',
    when: 'Upside: more coins and rooms seen. Risk: wanders into trouble. Pick when coins are in sight (`surroundings.coins`) or plenty is unexplored (`surroundings.unexplored_by_direction`), with no adversary in sight and full lives or hit protection.',
    priority: 'Greedy: loot comes first. Go for seen coins, then the move that would reveal the most new cells or a never-visited room; detours, corridors and side branches are fine. Still keep at least 3 steps from adversaries.',
    note: 'Goes after coins and unexplored rooms; detours are fine.',
    skill_priority: 'Strike an adjacent adversary whenever the sword is ready, then carry on looting.',
  },
  bold: {
    min_gap: 2, end_ticks: 1,
    move_priority: 'Bold: take the fight; moving toward an adversary is fine.',
    when: 'Upside: dispelling may drop a coin and brings the cleared win closer. Risk: a claw costs a life. Pick when a lone adversary is the only one known (in sight at any distance, or remembered), the sword is ready (`self.skills`) and you have full lives or hit protection.',
    priority: 'Bold: take the fight. Engage a lone or weakened adversary you can beat; moving toward one is fine; keep at least 2 steps unless striking.',
    note: 'Takes fights it can win: engages lone or weak adversaries.',
    skill_priority: 'Strike an adjacent adversary whenever the sword is ready, and step up to a hurt one.',
  },
};
const DEFAULT_SENTIMENT = 'steady';
export const profileOf = (memory) => SENTIMENTS[memory.sentiment?.id] ?? SENTIMENTS[DEFAULT_SENTIMENT];

// The gap a mood really keeps once the confidence model (PLAN-confidence C3) shifts it: base + delta from C,
// never below 2 when it lowers a gap. C null (toggle off) or in the neutral zone gives the base unchanged.
export function effectiveGap(base, C) {
  if (C == null) return base;
  const d = confidenceGaps(C);
  return d < 0 ? Math.max(2, base + d) : base + d;
}

// One mood's profile with the effective gap; every reader of the gap (tactic feasibility, targets, move facts,
// the failing test, the sentiment question, the mood lines below) takes it from here so Jev reads one number.
// The mood lines hard-code "at least N steps": templated from the gap, byte-identical while the gap is the base.
// C null (toggle off) returns the SENTIMENTS entry itself.
export function effectiveSentiment(id, C) {
  const base = SENTIMENTS[id];
  if (C == null) return base;
  const g = effectiveGap(base.min_gap, C);
  if (g === base.min_gap) return base;
  const fix = (t) => t.replace(/at least \d+ steps/, `at least ${g} steps`);
  return { ...base, min_gap: g, priority: fix(base.priority), move_priority: fix(base.move_priority) };
}

// effectiveProfile(memory, C): the current mood's profile at confidence C.
export const effectiveProfile = (memory, C) => effectiveSentiment(SENTIMENTS[memory.sentiment?.id] ? memory.sentiment.id : DEFAULT_SENTIMENT, C);
const profileNote = (id, C = null) => {
  const s = effectiveSentiment(id, C);
  return `min gap ${s.min_gap}; alert ${s.end_ticks} tick${s.end_ticks === 1 ? '' : 's'} after losing sight. ${s.note}`;
};

// The one place Jev is told what self.confidence means (sentiment question only; rules() rides on every request).
export const CONFIDENCE_SENTENCE = ' `self.confidence` sums up how your fights in this dungeon went; `threats` and the tactic facts say how this one stands.';

const TRIGGER_TEXT = {
  start: 'The explorer is about to start exploring the dark dungeon.',
  encounter: 'An adversary has just come into sight (or started chasing): the explorer must choose how to deal with it.',
  tactic_failed: 'The current tactic stopped working: its target is gone or the adversary got closer than the minimum gap.',
  chase_over: 'No adversary has been in sight for a while: the encounter is over and exploring resumes.',
  exit: 'The portal (the way out) has just been seen.',
  coins: 'Coins have just come into view nearby.',
  dispelled: 'The explorer has just dispelled an adversary; others may remain.',
  review: 'The explorer just dropped an exploration approach that was not working and switched to another.',
  hit: 'The explorer just lost a life to an adversary: rethink whether to keep at it.',
};

// How each tactic should shape the move while an adversary is in sight.
const TACTIC_MOVE_HINT = {
  run_away: 'Keep the distance growing; avoid known dead ends.',
  slip_past: 'Moving toward or alongside it is fine while the gap holds: follow the route past it.',
  engage: 'Go to the target: 2 steps off a hunting adversary, so it steps next to you and you strike first; next to one you stunned.',
  hide: 'Reach the target out of its sight fast; do not step back into its line of sight.',
  race_to_exit: 'Head straight for the portal; getting there first matters most.',
  carry_on: 'It has not seen you: keep exploring, out of its line of sight.',
};

// A function, not a constant: speed, lives and grace come from the tunables in src/settings.js.
// The objective is folded in, so nothing else repeats it.
// combat: null (no attack skill) or { name, damage, cooldown, stun, coinChance, clawCooldown, shield } (the live skill and settings numbers; shield: the block chance, null without a block skill).
const rules = (hasSkills = true, combat = null) =>
  'Goal: loot this dark dungeon and get out alive. Your score is the coins you hold when you win. ' +
  'You win by stepping onto the portal (it ends the game: leave once staying is not worth it) or by dispelling every adversary. At 0 lives you lose, coins and all. ' +
  'A step is up, down, left, right or stay. Each visited cell lights its surroundings for good: lit cells are known; the rest, and the portal until lit, are not. ' +
  `Adversaries chase an explorer they see, at ${speedPhrase()}. ` +
  `A touch only bumps. An adjacent adversary's claw costs ${skillConfig().clawDamage} ${skillConfig().clawDamage === 1 ? 'life' : 'lives'} (you start with ${EXPLORER_LIVES}); after a hit you are safe for ${GRACE_TICKS} steps. ` +
  '`threats.visible`: in sight now, with each health bar (`hp`); `threats.remembered`: seen earlier, frozen where last seen.' +
  (combat ? ` ${combatRule(combat)}` : '') +
  (hasSkills ? ' Besides moving you may use one skill (`self.skills`) per step.' : '');

// What a dispel pays, for the tactic priority line: "may drop a coin" (the chance is never stated), nothing at 0.
const engagePays = (p) => `dispelling it brings the cleared win closer${p > 0 ? ' and may drop a coin' : ''}`;
const chancePhrase = (p) => (p >= 1 ? 'every time' : p === 0.5 ? 'half the time' : `${Math.round(p * 100)}% of the time`);
// What the sword does, with the live numbers: the facts that make a fight worth weighing.
// The "next strike lands first" clause is claimed only while the stun outlasts the sword's cooldown and lasts 2+
// steps (strike, close in, strike again is two ticks): the stubbed duels (check-skills section 12) show a claw in
// between with a 1-step stun at full speed or a sword cooldown of 3 against a 2-step stun.
const stunHolds = (stun, cooldown) => stun >= 2 && cooldown < stun;
function combatRule({ name, damage, cooldown, stun, coinChance, clawCooldown, shield }) {
  const loot = coinChance > 0 ? ' and may drop a coin' : ''; // the chance is never stated (user decision)
  return `Your ${name.toLowerCase()} always hits an adjacent adversary: it loses ${damage} hp${stun ? ` and is knocked back and stunned ${stun} step${stun === 1 ? '' : 's'}` : ''}` +
    `${stunHolds(stun, cooldown) ? ', so your next strike lands before it can claw' : ''}; at 0 hp it is gone for good${loot}. ` +
    `An adversary's claw needs ${clawCooldown} step${clawCooldown === 1 ? '' : 's'} to recharge` +
    `${shield > 0 ? `, and your shield stops it ${chancePhrase(shield)}` : ''}.`;
}

// Encounter sentences that repeat a tactic option's own fact (dropped when the tactic question is asked).
const TACTIC_FACT_KEYS = ['slip_past', 'hide', 'run_away', 'exit'];
const COIN_NEAR = 8; // a newly seen pile this many known-path steps away or less can start a coin decision
const COIN_EVERY = 10; // min steps between coin decisions
const COIN_SWITCH = 0.5; // the coin decision's next_approach pick must reach this probability to switch
const LEAVE_NOW = 0.5; // leave_now.noul above this switches the approach to go_to_exit
const withoutKeys = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

// self.skills as Jev reads it: id -> 'ready' | 'ready in N' (the id names the skill; the rules sentence and
// the skill options carry the rest), so the request stays small.
const skillStates = (summaries) => Object.fromEntries(summaries.map((k) => [k.id, k.ready ? 'ready' : `ready in ${k.cooldown_left}`]));

// "steady×3 → wary": the mind picks as runs, oldest first.
function mindRuns(history) {
  const runs = [];
  for (const h of history) {
    if (runs.length && runs.at(-1).id === h.id) runs.at(-1).n++;
    else runs.push({ id: h.id, n: 1 });
  }
  return runs.map((r) => (r.n > 1 ? `${r.id}×${r.n}` : r.id)).join(' → ') || 'none yet';
}

const thoughtOf = (id) => APPROACHES[id]?.thought ?? 'Hmm, which way now?';
const approachOf = (id) => ({ id, text: APPROACHES[id].text, thought: APPROACHES[id].thought });

// One explorer: its memory (plain JSON, the persistent part of what Jev reads) plus the bookkeeping
// that must not reach Jev or disk. `ask` replaces the Jev call (the checks pass a stub),
// `memoryDir` is where memory.json/memory.md go. The brain reads the game only through its KnownWorld.
export class ExplorerBrain {
  #world;
  #ask;
  #memoryDir;
  #memory;
  // { step, targetSteps }: when the approach was last reviewed (or started) and how far its target
  // was then, so a review can tell travelling toward a far target from wandering.
  #review;
  // Encounter bookkeeping: { unseen, active (an encounter is on), encIds (seen this
  // encounter), modes (last seen mode per id), pending (a decision trigger waiting for the next
  // tick), lastDecision }.
  #encounter = { unseen: 0, active: false, encIds: new Set(), modes: new Map(), pending: null, lastDecision: -Infinity };
  // Coin decision: #coinKnown = keys of piles seen so far; #coinDue = a new pile lies within COIN_NEAR steps and a
  // next_approach question is waiting for a free tick; #coinStep = the step of the last coin decision.
  #coinKnown = new Set();
  #coinDue = false;
  #coinStep = -Infinity;
  #leaveDue = false; // the portal was just seen: ask leave_now on the next real choice
  // { id, cell }: the goal cell of the current tactic, kept so its target stays put.
  #tacticGoal = null;
  // Cells a tactic must not target any more: set when a ping-pong made the tactic fail (the cells it
  // bounced between and the target that led there), so the re-decision is a different one. Cleared
  // when the encounter starts or ends.
  #exclude = null;
  // id -> { id, cell, step, chasing, hp, maxHp }: adversaries this explorer SAW (health bar included), frozen at the last sighting.
  // Built only from visibleAdversaries(); expired by age or by seeing the empty cell.
  #seen = new Map();
  #everSeen = new Set(); // every adversary id the explorer has had in sight this game (minus the ones it dispelled): is this the only one it knows of?
  // Remembered sightings that are not visible now (what threats.remembered is built from), and the
  // known cells near recent ones (exploration approaches steer clear of them).
  #remembered = [];
  #zone = new Set();
  #lastBodies = [];
  // The explorer's skills (stateful: cooldowns); private. memory.skills mirrors their summaries and is rewritten before every save.
  #skills;
  // id -> the step the explorer last struck it (its own action, so fog-safe): engage closes in on a ghost
  // it stunned (#stunnedIds) instead of waiting for it.
  #struck = new Map();
  // Engage hold (P7a): { cell, n, adj } = where the explorer waits, consecutive hold ticks there, ticks spent beside the ghost.
  #hold = { cell: null, n: 0, adj: 0 };
  #holdOn = true;
  #skillEvents = []; // this turn's useSkill events (struck, dispelled, strike), reset each takeTurn
  // Confidence model (PLAN-confidence C2, off by default): #cs is confidence.js's state (value, counts, the
  // encounter's flags); memory.progress.confidence mirrors { value, counts } only with the toggle on.
  // #csLast / #csWhy feed the turn's `confidence` report (value change and events since the last report).
  #csOn = false;
  #cs = null;
  #csLast = 50;
  #csWhy = [];

  constructor(world, { ask = null, memoryDir = null, skills = 'explorer', hold = true, confidence = false } = {}) {
    this.#holdOn = hold; // false only for the duel checks that prove what the hold buys (P7a)
    this.#skills = typeof skills === 'string' || Array.isArray(skills) ? buildSkillSet(skills) : skills;
    this.#world = world;
    this.#ask = ask ?? askReal;
    this.#memoryDir = memoryDir ?? MEMORY_DIR;
    const memory = createMemory({
      approachId: 'nearest_frontier',
      approachText: APPROACHES.nearest_frontier.text,
      thought: APPROACHES.nearest_frontier.thought,
      sentiment: { id: DEFAULT_SENTIMENT },
      start: world.pos,
    });
    this.#memory = memory;
    setSkills(memory, this.#skills.summaries());
    this.#review = { step: 0, targetSteps: approachTarget(world, 'nearest_frontier')?.steps ?? null };
    memory.progress.known_floor_cells = world.knownFloorCount();
    this.#encounter.pending = 'start';
    if (confidence) { // no request text uses it yet (C3): it only moves and is reported
      this.#csOn = true;
      this.#cs = createConfidence();
      this.#syncConfidence();
    }
  }

  // Applies one confidence event with the lives left now (own state: fog-safe) and mirrors the result into memory.
  #confide(type) {
    if (!this.#csOn) return;
    this.#cs = applyConfidence(this.#cs, type, this.#world.health, this.#world.maxHealth);
    this.#csWhy.push(type);
    this.#syncConfidence();
  }

  // C for the gates: null with the toggle off (then every effective value is the plain SENTIMENTS one).
  #C() {
    return this.#csOn ? this.#cs.value : null;
  }

  // The current mood's profile at the current C (all gap readers below use it, never SENTIMENTS directly).
  #profile() {
    return effectiveProfile(this.#memory, this.#C());
  }

  // engage needs the sword ready and, with the model on, C >= ENGAGE_MIN.
  #engageArmed() {
    return this.#armed() && (!this.#csOn || engageOpen(this.#cs.value));
  }

  #syncConfidence() {
    this.#memory.progress.confidence = { value: this.#cs.value, counts: { ...this.#cs.counts } };
  }

  // The turn's `confidence` object for the UI: value, band word, change since the last report and why.
  #confidenceReport() {
    const value = this.#cs.value;
    const why = [...new Set(this.#csWhy)];
    const reason = (why.filter((w) => w !== 'calm').join(', ') || why[0]) ?? null;
    const delta = Math.round((value - this.#csLast) * 100) / 100;
    this.#csLast = value;
    this.#csWhy = [];
    return { value, band: confidenceBand(value), delta, reason };
  }

  // Own shield stopped a claw (called by turn.js from the 'blocked' event) and saves.
  async noteBlocked() {
    if (!this.#csOn) return;
    this.#confide('blocked');
    await this.#save();
  }

  get memory() {
    return this.#memory;
  }

  lastRequest() {
    return this.#lastBodies.length ? JSON.parse(this.#lastBodies.at(-1)) : null;
  }

  // Both bodies of the latest tick: [sentiment request, tick request] on a decision tick.
  lastRequests() {
    return this.#lastBodies.map((b) => JSON.parse(b));
  }

  // One Jev request. Keeps its exact body for lastRequest()/lastRequests().
  async #request(kind, state, questions) {
    const body = JSON.stringify({ model: 'jev-latest', state, questions });
    this.#lastBodies.push(body);
    const started = performance.now();
    const answers = await this.#ask({ kind, state, questions, body });
    return { answers, ms: Math.round(performance.now() - started) };
  }

  // The state Jev reads, regrouped: rules, then who the explorer is, what is around it, what
  // threatens it, what it is trying and what just happened. memory supplies the persistent parts,
  // `sit` (perception) everything recomputed this tick.
  // self.skills is a compact id -> readiness map (skillStates) to stay inside the request-size bounds.
  // tactics: this request carries the tactic question, whose options state each feasible tactic's own route
  // facts, so the encounter's per-tactic sentences (TACTIC_FACT_KEYS) are left out instead of sent twice.
  #state(sit, moves = null, tactics = false) {
    const m = this.#memory;
    const a = m.approach;
    const i = a.interrupted;
    return {
      game: rules(this.#skills.size > 0, this.#combat()),
      self: { ...sit.self, ...(this.#csOn ? { confidence: `${Math.floor(this.#cs.value)} ${confidenceBand(this.#cs.value)}` } : {}), ...(this.#skills.size ? { skills: skillStates(this.#skills.summaries()) } : {}), mind: { id: m.sentiment.id, since_step: m.sentiment.since_step, recent: mindRuns(m.sentiment_history) } },
      surroundings: moves ? { ...sit.surroundings, moves } : sit.surroundings,
      threats: tactics && sit.threats.encounter ? { ...sit.threats, encounter: withoutKeys(sit.threats.encounter, TACTIC_FACT_KEYS) } : sit.threats,
      plan: {
        approach: { id: a.id, current: a.current, since_step: a.since_step, interrupted: i ? { id: i.id, since_step: i.since_step, reason: i.reason } : null },
        // Not on the tactic request (the largest one; no review rides on it, and a tactic never reads `tried`):
        // a full list is about 600 B.
        ...(tactics ? {} : { tried: a.tried.map((t) => ({ id: t.id, steps: t.steps, reason: t.reason })) }),
      },
      recent: {
        path: m.recent.moves.map(dirWord),
        back_and_forth: m.recent.back_and_forth,
        revealed_since_approach: m.progress.revealed_since_approach,
        steps_since_approach: m.progress.steps_since_approach,
        revisits_last_10: m.progress.revisits_last_10,
        encounters: m.encounters,
        events: m.events,
      },
    };
  }

  // Freezes every adversary in sight as a sighting, then drops the ones that are stale (older than
  // REMEMBER_STEPS) or whose frozen cell the explorer can now see empty: within SIGHT_RANGE and in
  // known line of sight while that id is not visible, so it has moved on. Fog-safe: only
  // visibleAdversaries() and known cells are read, never where an unseen adversary really is.
  #observe() {
    const world = this.#world;
    const now = world.steps;
    const visible = new Set();
    for (const v of world.visibleAdversaries()) {
      visible.add(v.id);
      this.#everSeen.add(v.id);
      this.#seen.set(v.id, { id: v.id, cell: [...v.pos], step: now, chasing: v.mode === 'chase', hp: v.hp, maxHp: v.maxHp });
    }
    for (const [id, r] of this.#seen) {
      if (visible.has(id)) continue;
      const stale = now - r.step > REMEMBER_STEPS;
      const empty = euclid(world.pos, r.cell) <= SIGHT_RANGE && knownLineOfSight(world, world.pos, r.cell);
      if (stale || empty) this.#seen.delete(id);
    }
    this.#remembered = [...this.#seen.values()].filter((r) => !visible.has(r.id)).sort((x, y) => (x.id < y.id ? -1 : 1));
    this.#zone = avoidZone(world, this.#remembered);
  }

  // Fog-safe `self` for the skill options, and the options. Only visibleAdversaries() and the brain's own
  // sightings are read. Loose gate (D7): opponentsNear = something visible within SKILL_NEAR, or a
  // sighting up to SKILL_REMEMBER_STEPS steps old within SKILL_NEAR; threatNear = a visible chaser within
  // THREAT_STEPS path steps ({ id, steps } so the block fact can name it).
  #skillOptions() {
    const world = this.#world;
    if (!this.#skills.size) return {};
    const visible = world.visibleAdversaries();
    const near = visible.some((v) => v.distance <= SKILL_NEAR);
    const recalled = this.#remembered.some((r) => world.steps - r.step <= SKILL_REMEMBER_STEPS && euclid(world.pos, r.cell) <= SKILL_NEAR);
    const opponentsNear = near || recalled;
    let threatNear = false;
    if (GHOSTS_CAN_ATTACK) {
      const chasers = visible.filter((v) => v.mode === 'chase' && v.distance <= THREAT_STEPS + 1);
      if (chasers.length) {
        const dist = knownDistances(world, world.pos);
        for (const v of chasers) {
          const steps = dist.get(v.pos) ?? Math.round(euclid(world.pos, v.pos));
          if (steps <= THREAT_STEPS && (!threatNear || steps < threatNear.steps)) threatNear = { id: v.id, steps };
        }
      }
    }
    const self = {
      pos: [...world.pos],
      visibleOpponents: visible.map((v) => ({ id: v.id, pos: [...v.pos], mode: v.mode, distance: v.distance, hp: v.hp, maxHp: v.maxHp })),
      opponentsNear,
      threatNear,
      stunTicks: skillConfig().stunTicks,
      coinChance: skillConfig().coinDropChance,
    };
    return this.#skills.options({ pos: [...world.pos], facing: world.facing }, self);
  }

  // Ghosts the explorer's own strike still stuns on the turn being taken (struck less than stunTicks steps
  // ago): engage closes in on them. Built from the brain's own strikes only, never from a ghost's state.
  #stunnedIds() {
    const now = this.#world.steps + 1;
    return new Set([...this.#struck].filter(([, at]) => now - at < skillConfig().stunTicks).map(([id]) => id));
  }

  // What engage's option fact needs to say the fight in numbers: the sword's damage, whether the stun outlasts the
  // sword's cooldown (`steady`: the claw clause holds only then), and whether the adversary in sight is the only one
  // this explorer knows of (nothing remembered, no other id seen this game except the ones it dispelled). Own sight
  // only: it never claims it is the last one, only that it may clear the dungeon.
  #fight() {
    const k = this.#skills.skills.find((x) => x.kind === 'attack');
    if (!k) return null;
    return {
      damage: k.damage,
      steady: stunHolds(skillConfig().stunTicks, k.cooldown),
      only: this.#everSeen.size === 1 && this.#remembered.length === 0 && this.#world.visibleAdversaries().length === 1,
    };
  }

  // A ready attack skill is in hand (engage is offered only then).
  #armed() {
    return this.#skills.skills.some((k) => k.kind === 'attack' && k.ready);
  }

  // The rules' combat sentence numbers: the first attack skill and the live stun and coin settings; null without one.
  #combat() {
    const k = this.#skills.skills.find((x) => x.kind === 'attack');
    if (!k) return null;
    const c = skillConfig();
    const block = this.#skills.skills.find((x) => x.kind === 'block');
    return { name: k.name, damage: k.damage, cooldown: k.cooldown, stun: c.stunTicks, coinChance: c.coinDropChance, clawCooldown: c.clawCooldown, shield: block ? block.effectiveness : null };
  }

  // The engage hold (PLAN-motivation P7a): approach engage, ONE adversary in sight, hunting and not stunned by the
  // explorer's own strike, the sword ready, and the explorer already on the engage target (the cell 2 known-path steps
  // off, or next to it): code stays put with no move question. Stepping toward a hunting ghost hands it the first claw
  // (stubbed duels: check-skills section 12, check-duels), and the live runs lost 3 of 8 fights to exactly that step.
  // The skill question still goes out whenever the sword has an option, so the strike lands the tick the ghost steps
  // adjacent. Released (the normal question) after HOLD_MAX ticks without it coming, or HOLD_ADJACENT_MAX ticks beside
  // it without a strike; a stunned or patrolling ghost, a second adversary in sight or no sword keep the normal path.
  // Fog-safe: visible adversaries, the explorer's own strike record and its own sword only.
  #holding() {
    const world = this.#world;
    const h = this.#hold;
    const stop = () => { this.#hold = { cell: null, n: 0, adj: 0 }; return false; };
    if (!this.#holdOn || this.#memory.approach.id !== 'engage' || !this.#armed()) return stop();
    const threats = threatsOf(world);
    if (threats.length !== 1) return stop();
    const [th] = threats;
    const stunned = this.#stunnedIds();
    if (!th.chasing || stunned.has(th.id)) return stop();
    if (approachTarget(world, 'engage', { stunned })?.steps !== 0) return stop();
    const here = world.pos;
    const same = h.cell && sameCell(h.cell, here);
    if (threatDistance(th, here) <= 1) {
      this.#hold = { cell: [...here], n: 0, adj: (same ? h.adj : 0) + 1 };
      return this.#hold.adj <= HOLD_ADJACENT_MAX;
    }
    this.#hold = { cell: [...here], n: (same ? h.n : 0) + 1, adj: 0 };
    return this.#hold.n <= HOLD_MAX;
  }

  // Exploration target with this tick's sightings steered around (tactics ignore the zone).
  #target(id, opts = {}) {
    return approachTarget(this.#world, id, { avoid: this.#zone, ...opts });
  }

  async takeTurn() {
    const world = this.#world;
    const memory = this.#memory;
    const info = this.#encounter;
    const step = world.steps + 1;
    this.#skillEvents = [];
    const prev = world.steps;
    this.#lastBodies = [];
    this.#observe();
    // A tactic goal that was reached is done: left in place it would pull the explorer back to it later.
    if (this.#tacticGoal && sameCell(this.#tacticGoal.cell, world.pos)) this.#tacticGoal = null;
    let policy = null;
    this.#spotExit(prev); // a portal lit at the start (small testbed arenas), or one we missed
    this.#watchCoins();
    // collect_coins is done when no seen pile is reachable any more (all taken): back to the closest edge.
    if (memory.approach.id === 'collect_coins' && !this.#target('collect_coins')) {
      changeApproach(memory, approachOf('nearest_frontier'), prev); // not a failure: no plan.tried row
      this.#review = { step: Math.max(prev, 1), targetSteps: this.#target('nearest_frontier')?.steps ?? null };
      policy = { from: 'collect_coins', to: 'nearest_frontier', reason: 'no seen coins left to collect' };
    }
    const sit = situation(world, { remembered: this.#remembered, landmarks: memory.landmarks }); // computed before the move: what Jev sees this tick
    const enc = this.#encounterPolicy(sit, prev);
    policy = enc.policy ?? policy;

    const legal = world.availableMoves();
    if (!legal.length) throw new Error('No legal moves');
    const forced = legal.length === 1;
    const inSight = sit.threats.visible.length > 0;
    // Confidence context at the start of the tick (what the request shows): sword ready, ghosts the own strike stunned.
    const csArmed = this.#csOn ? this.#armed() : false;
    const csStunned = this.#csOn ? this.#stunnedIds() : null;
    const skillOptions = this.#skillOptions(); // computed before the move, like the facts Jev reads

    // A decision without an adversary in sight waits for the next tick with a real choice. When an
    // encounter starts on the same tick as a pending decision (start, exit, review), the
    // encounter trigger wins and the pending one is dropped: one sentiment call, not two.
    let trigger = enc.trigger ?? info.pending;
    // Coins in view with no other decision due: ask the mood first (greedy may fit), then next_approach below.
    // Same gates as askCoins; the 10-step cap is #coinStep (set when a coin decision runs).
    if (!trigger && this.#coinDue && !forced && !inSight && !isTactic(memory.approach.id) && memory.approach.id !== 'collect_coins' && !this.#leaving() && !this.#leaveDue &&
      step - info.lastDecision >= REDECIDE_COOLDOWN && !(step - this.#review.step >= REVIEW_EVERY && memory.progress.steps_since_approach >= REVIEW_EVERY)) trigger = 'coins';
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
      const sentiment = await this.#askSentiment(sit, trigger);
      apiMs += sentiment.ms;
      const profile = this.#profile();
      decision = { trigger, sentiment: { choice: sentiment.choice, probabilities: sentiment.probabilities }, tactic: null, apiMs: sentiment.ms };
      if (inSight) {
        const feasible = tacticFeasibility(world, profile.min_gap, { exclude: this.#exclude, armed: this.#engageArmed(), stunned: this.#stunnedIds(), fight: this.#fight() });
        decisionTargets = Object.fromEntries(Object.entries(feasible).map(([id, f]) => [id, f.target.cell]));
        const options = Object.fromEntries(TACTICS.filter((id) => feasible[id]).map((id) => [id, `${APPROACHES[id].brief} ${feasible[id].fact}`]));
        tacticIds = Object.keys(options);
        if (tacticIds.length === 1) {
          // Only one way to deal with it: code takes it, no one-option Choice.
          this.#applyTactic(tacticIds[0], trigger, prev, decisionTargets[tacticIds[0]]);
          decision.tactic = { choice: tacticIds[0], probabilities: { [tacticIds[0]]: 1 }, options };
          tacticIds = [];
        } else if (tacticIds.length) {
          decision.tactic = { choice: null, probabilities: null, options };
        }
      }
    }

    const profile = this.#profile();
    this.#keepEscapeGoal(profile);
    const hasSkillOptions = Object.keys(skillOptions).length > 0;
    // engage hold: stay, no move question (P7a). A decision tick (tactic question) is not a hold tick, so it restarts
    // the count: HOLD_MAX counts consecutive hold ticks, not ones split by a re-decision on the same cell.
    if (tacticIds.length) this.#hold = { cell: null, n: 0, adj: 0 };
    const held = !tacticIds.length && this.#holding();
    const questions = {};
    let moveOptions = {}; // per approach id: the shuffled move criteria
    let sharedMoves = null; // tactic-independent facts per move, sent once beside the speculative questions
    // A lone fight the duels back (#loneFight): under steady or greedy engaging is the default, so the mood's caution
    // does not talk the explorer out of the one fight it should take.
    const loneEngage = tacticIds.includes('engage') && this.#loneFight(sit) &&
      (memory.sentiment.id === 'steady' || memory.sentiment.id === 'greedy');
    if (tacticIds.length) {
      questions.tactic = {
        type: 'choice',
        instructions: {
          question:
            `${TRIGGER_TEXT[trigger]} Which tactic? Feeling ${memory.sentiment.id} (\`self.mind\`), the explorer keeps adversaries ` +
            `${profile.min_gap}+ steps away: only tactics allowing that are listed. Judge from \`threats\`.`,
          priorities: loneEngage
            ? [
              'Default: engage a lone adversary while the sword is ready (you act first). Run away when cramped or without the sword.',
              profile.priority,
              'Prefer a tactic that keeps making progress (slip past, carry on); racing to the portal ends the game.',
            ]
            : [
              profile.priority,
              'Prefer a tactic that keeps making progress (slip past, carry on); racing to the portal ends the game.',
              `Engage a lone adversary when the sword is ready: ${engagePays(skillConfig().coinDropChance)}. Run away when outnumbered, cramped or without the sword.`,
            ],
        },
        criteria: Object.fromEntries(shuffle(tacticIds).map((id) => [id, decision.tactic.options[id]])),
      };
      if (!forced) {
        for (const id of tacticIds) {
          const q = this.#moveQuestion(id, sit, profile, true, hasSkillOptions);
          questions[`move_if_${id}`] = q.question;
          moveOptions[id] = q.options;
          // engage judges moves without the minimum gap; the shared facts keep the mood's gap warnings.
          if (id !== 'engage' || !sharedMoves) sharedMoves = q.shared;
        }
      }
    } else if (!forced && !held) {
      const q = this.#moveQuestion(memory.approach.id, sit, profile, false, hasSkillOptions);
      questions.next_move = q.question;
      moveOptions[memory.approach.id] = q.options;
    }

    const approachId = memory.approach.id;
    const rInfo = this.#review;
    const sinceReview = step - rInfo.step;
    // No reviews while a tactic or the run for the portal is on: those last as long as the situation does.
    const reviewDue =
      !forced && !tacticIds.length && approachId !== 'go_to_exit' && !isTactic(approachId) &&
      sinceReview >= REVIEW_EVERY && memory.progress.steps_since_approach >= REVIEW_EVERY;
    if (reviewDue) this.#addReviewQuestions(questions, approachId, rInfo);
    // leave_now: on the first tick after the portal was seen, and in every review while it is known.
    // Never while leaving is already the plan, and not beside a tactic question (race_to_exit covers
    // leaving under threat; that request is the largest): it waits for the next tick, a tactic may be on.
    const askLeave = !forced && !tacticIds.length && exitSeen(world) && !this.#leaving() && (this.#leaveDue || reviewDue);
    if (askLeave) {
      this.#leaveDue = false;
      questions.leave_now = this.#leaveQuestion(sit);
    }
    // Coin decision: a new pile came into view nearby. next_approach, in this tick's request, after the sentiment call
    // (only on a decision tick: the `coins` trigger asked the mood just before, or another trigger's call serves). Not beside a tactic, a review or leave_now (they are the big requests); it waits.
    const askCoins = this.#coinDue && !!trigger && !forced && !tacticIds.length && !reviewDue && !askLeave && !isTactic(approachId) &&
      approachId !== 'collect_coins' && !this.#leaving();
    if (askCoins) {
      this.#coinDue = false;
      this.#coinStep = step;
      questions.next_approach = this.#nextApproachQuestion(
        availableApproaches(world).filter((id) => id !== 'go_to_exit'),
        'Coins have come into view (`surroundings.coins`). Which approach should the explorer follow now? Keep `plan.approach.current` unless going for the coins is worth the detour (adversaries, `threats.remembered`, what is left to explore).',
      );
    }
    // ONE skill question per request (never per tactic, never in the sentiment request). On a forced tick
    // it is the only question: a skill-only request (PLAN D4-a).
    const skillQ = hasSkillOptions ? skillQuestion(skillOptions, profile.skill_priority, { neutral: true }) : null;
    if (skillQ) questions.skill = skillQ;

    let dir = held ? STAY : legal[0];
    let moveDecision = null;
    let review = null;
    let pendingSwitch = null;
    let pendingLeave = null;
    let pendingCoins = null;
    let skillDecision = null;
    let skillKey = 'none';
    if (Object.keys(questions).length) {
      const res = await this.#request('tick', this.#state(sit, sharedMoves, Boolean(questions.tactic)), questions);
      apiMs += res.ms;
      const answers = res.answers;
      if (skillQ) {
        skillKey = pickSkill(answers.skill, skillOptions);
        skillDecision = { choice: answers.skill?.choice ?? null, probabilities: answers.skill?.probabilities ?? null, used: null };
      }

      let moveKey = 'next_move';
      let moveFor = memory.approach.id;
      if (tacticIds.length) {
        const c = answers.tactic?.choice;
        const chosen = tacticIds.includes(c) ? c : tacticIds.includes('run_away') ? 'run_away' : tacticIds[0];
        decision.tactic = { choice: chosen, probabilities: answers.tactic?.probabilities ?? null, options: decision.tactic.options };
        this.#applyTactic(chosen, trigger, prev, decisionTargets[chosen]);
        moveKey = `move_if_${chosen}`;
        moveFor = chosen;
      }
      const a = answers[moveKey];
      if (!forced && a) {
        dir = legal.includes(a.choice) ? a.choice : legal[0];
        moveDecision = { choice: dir, probabilities: a.probabilities, confidence: a.confidence, options: moveOptions[moveFor] };
      }

      const leave = askLeave ? answers.leave_now?.noul : null;
      if (typeof leave === 'number' && leave > LEAVE_NOW) pendingLeave = leave;

      const coinPick = askCoins ? answers.next_approach : null;
      if (coinPick && coinPick.choice !== approachId && APPROACHES[coinPick.choice] && !isTactic(coinPick.choice)) {
        const p = coinPick.probabilities?.[coinPick.choice] ?? coinPick.confidence ?? 1;
        if (p >= COIN_SWITCH) pendingCoins = { id: coinPick.choice, p };
      }

      if (reviewDue && answers.approach_working) {
        this.#review = { step, targetSteps: this.#target(approachId)?.steps ?? null };
        const working = answers.approach_working.noul;
        review = { working, switched: false, from: approachId, to: approachId, reason: null };
        if (working < APPROACH_FAILING && answers.next_approach && APPROACHES[answers.next_approach.choice] && !isTactic(answers.next_approach.choice)) {
          const p = memory.progress;
          const reason =
            `Jev judged it not working (${Math.round(working * 100)}%): ${p.revealed_since_approach} cells revealed in ` +
            `${p.steps_since_approach} steps, ${p.revisits_last_10} revisits in the last 10.`;
          pendingSwitch = { id: answers.next_approach.choice, reason, working };
          review = { ...review, switched: true, to: pendingSwitch.id, reason };
        }
      }
    }
    if (decision) decision.apiMs = apiMs; // the whole decision tick: sentiment + tick request

    const csEngaging = memory.approach.id === 'engage'; // after this tick's decision, like the request's plan.approach
    // The skill resolves BEFORE the step, so the facts Jev read are exact when it lands.
    if (skillKey !== 'none') skillDecision.used = this.#useSkill(skillKey, step);

    const result = world.move(dir);
    recordStep(memory, {
      step: world.steps,
      dir,
      pos: world.pos,
      revealed: result.revealed,
      revisit: result.revisit,
      known_floor_cells: world.knownFloorCount(),
      coins: world.coins,
    });
    if (result.coins) addEvent(memory, world.steps, `Picked up ${result.coins === 1 ? 'a coin' : `${result.coins} coins`}: ${world.coins} in all.`);
    if (!result.won) this.#noteLandmarks(world.steps);
    if (!result.won) this.#spotExit(world.steps);
    // Leaving is Jev's call (leave_now), and it outranks any review outcome.
    if (pendingLeave !== null && !result.won) policy = this.#leave(pendingLeave, world.steps);
    else if (pendingCoins && !result.won && !isTactic(memory.approach.id)) {
      const from = memory.approach.id;
      const reason = `Coins came into view: Jev picked ${pendingCoins.id} (${Math.round(pendingCoins.p * 100)}%).`;
      changeApproach(memory, approachOf(pendingCoins.id), world.steps); // a coin detour is not a failure: no plan.tried row
      addEvent(memory, world.steps, `Switched from ${from} to ${pendingCoins.id} ${pendingCoins.id === 'collect_coins' ? 'for' : 'with'} the coins in view.`);
      this.#review = { step: world.steps, targetSteps: this.#target(pendingCoins.id)?.steps ?? null };
      policy = { from, to: pendingCoins.id, reason };
    }
    else if (pendingSwitch && !result.won && !isTactic(memory.approach.id)) {
      const from = memory.approach.id;
      switchApproach(memory, approachOf(pendingSwitch.id), pendingSwitch.reason, world.steps);
      addEvent(memory, world.steps, `Dropped ${from} for ${pendingSwitch.id} after a review (judged ${Math.round(pendingSwitch.working * 100)}% working).`);
      this.#review = { step: world.steps, targetSteps: this.#target(pendingSwitch.id)?.steps ?? null };
      info.pending = info.pending ?? 'review'; // the new approach gets its sentiment next tick
    }
    if (result.won) addEvent(memory, world.steps, result.moved ? `Stepped through the portal with ${world.coins === 1 ? '1 coin' : `${world.coins} coins`}.` : 'Dispelled the last adversary and won.');
    this.#skills.turnPassed();
    if (this.#csOn) {
      // Calm repairs toward the start; pressed (a chaser within 2 steps, sword down) is not the engage hold or a stunned ghost.
      if (!sit.threats.visible.length) this.#confide('calm');
      else if (!csArmed && !csEngaging && sit.threats.visible.some((v) => v.chasing && v.distance <= PRESSED_RANGE && !csStunned.has(v.id))) this.#confide('pressed');
    }
    await this.#save();

    return {
      step: world.steps, dir, forced: moveDecision === null, revealed: result.revealed, won: result.won,
      move_decision: moveDecision, held, decision, review, policy, skill_decision: skillDecision, skill_events: this.#skillEvents, apiMs,
      ...(this.#csOn ? { confidence: this.#confidenceReport() } : {}),
    };
  }

  // Uses the picked skill through the world, notes what it did. Returns the key used, or null when the
  // world refused (not ready / unknown). Fog-safe: only ids the explorer saw can be struck.
  #useSkill(key, step) {
    const world = this.#world;
    const memory = this.#memory;
    const picked = this.#skills.get(key);
    const res = world.useSkill(this.#skills, key);
    const events = Array.isArray(res) ? res : res?.events;
    if (!events) return null;
    this.#skillEvents.push(...events); // handed to Run.playTurn through the turn shape
    for (const e of events) {
      if (e.type === 'struck') {
        this.#struck.set(e.id, step);
        this.#confide('struck');
        addEvent(memory, step, `Struck ${e.id} with the ${picked?.skill.source || 'weapon'} (${e.hp} hp left).`);
      } else if (e.type === 'dispelled') {
        const coin = events.some((x) => x.type === 'coin_drop' && x.id === e.id);
        countEncounter(memory, 'dispelled', step);
        this.#confide('dispelled');
        addEvent(memory, step, `Dispelled ${e.id}${coin ? '; it dropped a coin' : ''}.`);
        this.#seen.delete(e.id); // it is gone, and the explorer saw it go
        this.#everSeen.delete(e.id); // so a lone survivor in sight may still be "the only one it knows of"
        this.#struck.delete(e.id);
        this.#encounter.pending ??= 'dispelled'; // rethink the mood next tick (a win ends the game first)
      }
    }
    return key;
  }

  // Mirrors the live skills into memory, then saves (every save goes through here).
  async #save() {
    setSkills(this.#memory, this.#skills.summaries());
    await saveMemory(this.#memory, this.#memoryDir);
  }

  // Records a catch (called by turn.js after the adversaries moved) and saves.
  async noteCaught(adversaryId) {
    const world = this.#world;
    const memory = this.#memory;
    const at = Math.max(world.steps, 1);
    countEncounter(memory, 'hits', at);
    addEvent(memory, at, `Caught by ${adversaryId}: the last life is gone.`);
    addLandmark(memory, { kind: 'hit_here', cell: world.pos, step: at, note: 'Took a hit here.' });
    await this.#save();
  }

  // Records a hit that cost a life but did not end the game (called by turn.js) and saves.
  async noteHit(adversaryId) {
    const world = this.#world;
    const memory = this.#memory;
    const at = Math.max(world.steps, 1);
    countEncounter(memory, 'hits', at);
    this.#confide('hit');
    addEvent(memory, at, `Hit by ${adversaryId}: ${world.health} of ${world.maxHealth} lives left.`);
    // A tactic never fails on a lost life by itself (engage never fails by gap): ask again next tick.
    if (isTactic(memory.approach.id)) this.#encounter.pending = 'hit';
    addLandmark(memory, { kind: 'hit_here', cell: world.pos, step: at, note: 'Took a hit here.' });
    await this.#save();
  }

  // Landmarks that come from where the explorer just stood (after its move): a known dead end with
  // nothing left to explore beyond it, and the cell a hide tactic was heading for.
  #noteLandmarks(step) {
    const world = this.#world;
    const memory = this.#memory;
    const here = world.pos;
    const exits = neighbours(here).filter((c) => knownFloor(world, c)).length;
    if (exits === 1 && !isFrontier(world, here)) {
      addLandmark(memory, { kind: 'dead_end_explored', cell: here, step, note: 'Dead end, explored: nothing beyond it.' });
    }
    const goal = this.#goal();
    if (memory.approach.id === 'hide' && goal && sameCell(goal, here)) {
      addLandmark(memory, { kind: 'hiding_spot_used', cell: here, step, note: "Hid here, out of an adversary's sight." });
    }
  }

  // A fight the duels bear out (check-skills section 12): one adversary in sight and none remembered, the sword
  // ready, the stun outlasting the sword's cooldown, at most 2 strikes to dispel it (then it costs at most one claw),
  // and one claw cannot end the game: lives above the claw's damage and full lives or hit protection (bold's `when`).
  // Reads only the explorer's own state, the visible adversary's hp and the sword.
  #loneFight(sit) {
    const world = this.#world;
    const fight = this.#fight();
    const [v] = world.visibleAdversaries();
    if (!fight?.steady || !this.#armed() || sit.threats.visible.length !== 1 || sit.threats.remembered.length || !v) return false;
    if (Math.ceil(v.hp / fight.damage) > 2) return false;
    return world.health > skillConfig().clawDamage && (world.health >= world.maxHealth || world.graceLeft > 0);
  }

  // The encounter's stakes in one sentence, only for a #loneFight. Otherwise ''.
  #stakes(sit, trigger) {
    if (!['encounter', 'tactic_failed', 'hit'].includes(trigger) || !this.#loneFight(sit)) return '';
    return ' A lone adversary you can strike first costs at most one claw and a dispel removes it for good; running may leave it hunting you.';
  }

  // Request 1 of a decision step. Sets memory.sentiment and returns { choice, probabilities, ms }.
  async #askSentiment(sit, trigger) {
    const world = this.#world;
    const memory = this.#memory;
    const ids = Object.keys(SENTIMENTS);
    const inSight = sit.threats.visible.length > 0;
    // With an adversary in sight, each mood also says which tactics its minimum gap leaves open here.
    const allowed = new Map();
    const C = this.#C();
    if (inSight) {
      for (const g of new Set(ids.map((id) => effectiveSentiment(id, C).min_gap))) {
        allowed.set(g, Object.keys(tacticFeasibility(world, g, { exclude: this.#exclude, armed: this.#engageArmed(), stunned: this.#stunnedIds() })).map((id) => id.replace(/_/g, ' ')));
      }
    }
    const criteria = Object.fromEntries(shuffle(ids).map((id) => {
      const s = effectiveSentiment(id, C);
      const here = inSight ? ` Tactics it leaves here: ${allowed.get(s.min_gap).join(', ') || 'none, only luck'}.` : '';
      return [id, `${s.when} Effect: ${profileNote(id, C)}${here}`];
    }));
    const questions = {
      sentiment: {
        type: 'choice',
        instructions:
          `${TRIGGER_TEXT[trigger]}${this.#stakes(sit, trigger)} What should the explorer go after right now: safety (wary), the plan (steady), loot (greedy) or the fight (bold)? ` +
          'The mood sets how close adversaries may come (min gap) and how long it stays alert after losing sight of them. Judge from `surroundings`, ' +
          '`threats` (in sight, remembered, encounter), `recent` and `self.mind`. Pick what the circumstances call for, not the last mood by habit.' +
          (this.#csOn ? CONFIDENCE_SENTENCE : ''),
        criteria,
      },
    };
    const { answers, ms } = await this.#request('sentiment', this.#state(sit), questions);
    const a = answers.sentiment;
    const choice = SENTIMENTS[a?.choice] ? a.choice : memory.sentiment.id;
    setSentiment(memory, { id: choice }, world.steps + 1);
    return { choice, probabilities: a?.probabilities ?? null, ms };
  }

  // next_move for one approach. speculative: asked once per tactic on a decision tick, so it keeps
  // only the safety line, the tactic's own hint and the mood's priority (the generic list lives in next_move).
  #moveQuestion(approachId, sit, profile, speculative, skillLine = false) {
    const world = this.#world;
    const memory = this.#memory;
    const cells = memory.recent.cells;
    // engage closes in on purpose: its moves are judged without the mood's minimum gap.
    const gap = approachId === 'engage' ? 1 : profile.min_gap;
    const parts = describeMoveParts(world, approachId, {
      minGap: gap,
      goal: speculative ? null : this.#goal(),
      avoid: this.#zone,
      exclude: this.#exclude,
      remembered: this.#remembered,
      prev: cells.length > 1 ? cells.at(-2) : null,
      backAndForth: memory.recent.back_and_forth,
      stunned: this.#stunnedIds(),
    });
    // Option order is shuffled every tick because Jev leans toward the first option.
    // Speculative: the facts that do not depend on the tactic are sent once, in `surroundings.moves`
    // (same for every move_if_<tactic>); each option keeps only its progress toward this tactic's target.
    const dirs = shuffle(world.availableMoves());
    const whole = (p) => p.whole ?? [p.shared, p.target].filter(Boolean).join(' ');
    // `stay` is the same under every tactic, so its whole fact goes to the shared facts and the option is short.
    const specOption = (d) => (d === STAY ? (parts[d].holding ? parts[d].whole : 'Stand still.') : parts[d].whole ?? parts[d].target);
    const options = Object.fromEntries(dirs.map((d) => [d, speculative ? specOption(d) : whole(parts[d])]));
    const shared = Object.fromEntries(world.availableMoves().filter((d) => d === STAY || !parts[d].whole).map((d) => [d, parts[d].shared ?? parts[d].whole]));
    const question = speculative
      ? `Step for the "${approachId}" tactic? Options: progress to its target; other facts per move: \`surroundings.moves\`.`
      : `Which way should the explorer step next? It feels ${memory.sentiment.id} (\`self.mind\`); judge each move from its description, \`surroundings\` and \`recent\`.`;
    const portalSeen = sit.surroundings.exit !== 'not seen yet';
    // Stepping onto the portal ends the game, so it is only the plan when leaving is.
    const leavingNow = approachId === 'go_to_exit' || approachId === 'race_to_exit';
    const portalLine = leavingNow
      ? speculative
        ? 'Take a move onto the portal; else head for it.'
        : 'Take a move onto the portal; else move closer to it along the known path.'
      : speculative
        ? 'Onto the portal only to leave or dodge a strike.'
        : 'A move onto the portal ends the game: take it only if leaving now is the plan or an adversary would otherwise strike you.';
    const engaging = approachId === 'engage';
    const hint = TACTIC_MOVE_HINT[approachId] ?? 'Avoid known dead ends where you can be cornered; keep the distance growing.';
    const safety = sit.threats.visible.length
      ? [
          approachId === 'engage'
            ? `Never step onto an adversary. ${hint}`
            : speculative
            ? `Never step into an adversary; keep ${gap}+ steps from it. ${hint}`
            : `Never step into an adversary; avoid moves marked "below your minimum gap" (under ${gap} steps). ${hint}`,
        ]
      : [];
    // The one-per-tactic questions decide the move on a decision tick, so they keep the mood's rule (shortened).
    const priorities = speculative
      ? [...(portalSeen ? [portalLine] : []), ...safety, ...(engaging ? [] : [profile.move_priority])]
      : engaging ? [
          // engage: the hint in `safety` is the whole plan. The mood's lines ("moving toward one is fine"), "stay makes no
          // progress" and "reveal new cells" would talk the explorer off the holding cell (P7a).
          ...(portalSeen ? [portalLine] : []),
          ...safety,
          ...(sit.threats.remembered.length ? ['Do not head toward where an adversary was last seen (`threats.remembered`) unless the approach needs it.'] : []),
          ...(skillLine ? [`Skills: ${profile.skill_priority}`] : []),
        ]
      : [
          ...(portalSeen ? [portalLine] : []),
          ...safety,
          ...(sit.threats.remembered.length ? ['Do not head toward where an adversary was last seen (`threats.remembered`) unless the approach needs it.'] : []),
          ...(nearbyPiles(this.#world, COIN_NEAR).length ? ['Coins are the score: a step toward a seen pile beats revealing new cells unless an adversary is near.'] : []),
          profile.priority,
          ...(skillLine ? [`Skills: ${profile.skill_priority}`] : []),
          'Stay makes no progress and lets adversaries close in: only when every step is worse.',
          'Follow the approach (`plan.approach.current`): prefer moves closer to its target.',
          'Prefer moves revealing many new cells or onto never-visited cells.',
          'Avoid backtracking: no known dead end with nothing left to explore, and do not undo the previous move unless every other way is explored (`recent`).',
        ];
    return { options, shared, question: { type: 'choice', instructions: { question, priorities }, criteria: options } };
  }

  #addReviewQuestions(questions, approachId, info) {
    const world = this.#world;
    const target = this.#target(approachId);
    const travel = !target
      ? ' The approach has no target left: no reachable edge of the known map.'
      : info.targetSteps === null
        ? ` Its target is now ${target.steps} known-path steps away.`
        : ` Its target is now ${target.steps} known-path steps away (it was ${info.targetSteps} at the last check).`;
    questions.approach_working = {
      type: 'noul',
      instructions:
        'Since `plan.approach.since_step`, is `plan.approach.current` making real progress revealing new ground? Judge from `recent` (cells revealed and steps taken since the approach started, revisits, back-and-forth) and `surroundings`.' +
        travel +
        ' Walking over visited cells is fine while the target keeps getting closer; switching approach mid-journey usually means turning back.',
      criteria: {
        true: 'Progress: new territory is being lit up steadily, or the explorer is still crossing known ground on a direct route toward unexplored space (an approach that travels far needs a few steps before it reveals anything).',
        false: 'Stuck: going back and forth, circling through explored ground, or revisiting cells many times while revealing almost nothing.',
      },
    };
    // go_to_exit is never a review alternative: leave_now is the only way into it.
    const alternatives = availableApproaches(world).filter((id) => id !== approachId && id !== 'go_to_exit');
    if (alternatives.length) {
      questions.next_approach = this.#nextApproachQuestion(
        alternatives,
        'If `plan.approach.current` were dropped, which approach should the explorer try next? Avoid approaches in `plan.tried` that already failed, use `surroundings.unexplored_by_direction`, and steer clear of where adversaries were just seen (`threats.remembered`).',
      );
    }
  }

  // A next_approach Choice over `ids` (shuffled), each option saying what it means and where it leads from here.
  #nextApproachQuestion(ids, instructions) {
    return { type: 'choice', instructions, criteria: Object.fromEntries(shuffle(ids).map((id) => [id, this.#approachOption(id)])) };
  }

  // Remembers which piles were seen. A pile seen for the first time within COIN_NEAR known-path steps queues a
  // coin decision, unless the last one was under COIN_EVERY steps ago (one first sight, one chance: a pile first
  // seen farther off, or during the cooldown, never queues it; only a busy tick delays it); the queue empties when
  // no seen pile is that near any more. Lit piles only (KnownWorld.seenCoins).
  #watchCoins() {
    const world = this.#world;
    const fresh = new Set();
    for (const c of world.seenCoins()) {
      const k = key(c);
      if (!this.#coinKnown.has(k)) { this.#coinKnown.add(k); fresh.add(k); }
    }
    if (!this.#coinKnown.size) return;
    const near = nearbyPiles(world, COIN_NEAR);
    if (!near.length) this.#coinDue = false;
    else if (near.some((p) => fresh.has(key(p.cell))) && world.steps + 1 - this.#coinStep >= COIN_EVERY) this.#coinDue = true;
  }

  // Starts tactic `id` (parking the exploration approach; a tactic-to-tactic switch keeps the parked
  // one). Tactics never go into `tried`. Re-picking the current tactic changes nothing.
  #applyTactic(id, trigger, prev, cell) {
    const memory = this.#memory;
    if (cell) this.#tacticGoal = { id, cell };
    if (memory.approach.id === id) return;
    interruptApproach(memory, approachOf(id), trigger === 'encounter' ? 'met an adversary' : `encounter: ${trigger.replace(/_/g, ' ')}`, prev);
    this.#review = { step: prev + 1, targetSteps: null };
  }

  // Encounter bookkeeping, run at the start of every tick from what the explorer sees now (after
  // the adversaries' last moves). Returns { trigger, policy }:
  //   - an adversary comes into sight with no tactic on, a new one appears during the encounter,
  //     or a visible one switches patrol -> chase: trigger 'encounter'
  //   - the current tactic's target is gone, or (except run_away) the gap fell below the
  //     sentiment's min_gap, or the explorer is going back and forth: trigger 'tactic_failed'
  //     (at most every REDECIDE_COOLDOWN ticks, and only while an adversary is in sight, the one
  //     time a tactic can be re-picked)
  //   - the sentiment's end_ticks with nothing in sight: the encounter is over, the parked approach
  //     resumes (policy) and trigger 'chase_over'
  #encounterPolicy(sit, prev) {
    const world = this.#world;
    const memory = this.#memory;
    const info = this.#encounter;
    const visible = world.visibleAdversaries();
    const at = Math.max(prev, 1);
    const step = prev + 1;
    const profile = this.#profile();
    const a = memory.approach;

    if (visible.length && !info.active) {
      info.active = true;
      this.#exclude = null;
      countEncounter(memory, 'count', at);
    }

    if (visible.length) info.unseen = 0;
    else info.unseen += 1;
    if (this.#csOn && visible.some((v) => v.mode === 'chase')) this.#cs = seeChase(this.#cs);

    let trigger = null;
    let policy = null;
    const inEncounter = isTactic(a.id);
    if (visible.length) {
      const newcomer = visible.some((v) => !info.encIds.has(v.id));
      const turned = visible.some((v) => v.mode === 'chase' && info.modes.get(v.id) === 'patrol');
      // (Without a tactic on, e.g. no tactic was feasible last time, retry only after the cooldown.)
      if (newcomer || turned || (!inEncounter && step - info.lastDecision >= REDECIDE_COOLDOWN)) trigger = 'encounter';
      else if (step - info.lastDecision >= REDECIDE_COOLDOWN) {
        const failing = this.#tacticFailing(profile, sit);
        const bounced = this.#pingPong(prev);
        if (failing || bounced) trigger = 'tactic_failed';
        if (bounced) this.#bounce();
      }
      for (const v of visible) {
        info.encIds.add(v.id);
        info.modes.set(v.id, v.mode);
      }
    } else if (inEncounter && info.unseen >= profile.end_ticks) {
      countEncounter(memory, 'escaped', at);
      const from = a.id;
      if (!resumeApproach(memory, prev, thoughtOf)) {
        interruptApproach(memory, approachOf('nearest_frontier'), 'encounter over', prev);
        a.interrupted = null;
      }
      this.#review = { step: at, targetSteps: this.#target(a.id)?.steps ?? null };
      policy = { from, to: a.id, reason: `no adversary in sight for ${info.unseen} tick${info.unseen === 1 ? '' : 's'}` };
      trigger = 'chase_over';
      if (this.#csOn) { // evaded: it had a chasing sighting and ended with no hit and no dispel
        const evaded = this.#cs.counts.evaded;
        this.#cs = closeEncounter(this.#cs, world.health, world.maxHealth);
        if (this.#cs.counts.evaded > evaded) { this.#csWhy.push('evaded'); this.#syncConfidence(); }
      }
      info.active = false;
      this.#exclude = null;
      info.encIds = new Set();
      info.modes = new Map();
    }
    return { trigger, policy };
  }

  // Going back and forth under a tactic: PINGPONG_FAILS moves in the recent window returned to the
  // cell just left. Only the moves since the last decision count, so a re-decision that keeps the
  // tactic gets a fresh run before it can fail again.
  #pingPong(prev) {
    const r = this.#memory.recent;
    const moves = Math.min(LIMITS.recentMoves, prev - this.#encounter.lastDecision + 1);
    return isTactic(this.#memory.approach.id) && backAndForth(r.cells, moves) >= PINGPONG_FAILS;
  }

  // A tactic that bounced the explorer between two cells failed for a reason a re-pick of the same
  // target would not fix (Jev often picks run_away again, it is the only safe tactic): rule out the
  // cells it bounced between and the target that led there, so the re-decision gets a different one.
  #bounce() {
    const cells = this.#memory.recent.cells.slice(-2).map(key);
    const goal = this.#goal();
    this.#exclude = new Set([...(this.#exclude ?? []), ...cells, ...(goal ? [key(goal)] : [])]);
    this.#tacticGoal = null;
  }

  // run_away keeps its escape spot every tick (not only at decisions) so it cannot flip between two
  // cells as the adversary moves: approachTarget keeps the goal until it is reached or unsafe.
  #keepEscapeGoal(profile) {
    if (this.#memory.approach.id !== 'run_away') return;
    const t = approachTarget(this.#world, 'run_away', { minGap: profile.min_gap, goal: this.#goal(), exclude: this.#exclude, remembered: this.#remembered });
    this.#tacticGoal = t ? { id: 'run_away', cell: t.cell } : null;
  }

  // The kept goal of the current tactic (null when it belongs to another tactic).
  #goal() {
    const memory = this.#memory;
    const g = this.#tacticGoal;
    return g && g.id === memory.approach.id ? g.cell : null;
  }

  #tacticFailing(profile, sit) {
    const world = this.#world;
    const memory = this.#memory;
    const id = memory.approach.id;
    const target = approachTarget(world, id, { minGap: profile.min_gap, goal: this.#goal(), exclude: this.#exclude, remembered: this.#remembered, stunned: this.#stunnedIds() });
    if (target) this.#tacticGoal = { id, cell: target.cell };
    if (!target) return true;
    // run_away never fails by gap, and engage closes the gap on purpose.
    return id !== 'run_away' && id !== 'engage' && sit.threats.encounter && sit.threats.encounter.gap_now < profile.min_gap;
  }

  // An approach option for Jev: what it means plus where it would lead from here (known cells only).
  #approachOption(id) {
    const t = this.#target(id);
    return `${APPROACHES[id].text} ${t ? t.why : 'No reachable target from here.'}`;
  }

  // The portal is known: record it once (event, landmark) and queue a decision tick that also asks
  // leave_now. No approach change: leaving is Jev's call (see #leave).
  #spotExit(step) {
    const world = this.#world;
    const memory = this.#memory;
    if (world.won || !exitSeen(world) || memory.landmarks.some((l) => l.kind === 'exit')) return;
    const at = Math.max(step, 1);
    addEvent(memory, at, 'Saw the portal.');
    addLandmark(memory, { kind: 'exit', cell: world.seenTreasure(), step, note: 'The portal: stepping on it leaves and ends the game.' });
    this.#encounter.pending = 'exit';
    this.#leaveDue = true;
  }

  // Leaving is already the plan: the approach (or, mid-encounter, the parked one) is go_to_exit.
  #leaving() {
    const a = this.#memory.approach;
    return a.id === 'go_to_exit' || a.id === 'race_to_exit' || a.interrupted?.id === 'go_to_exit';
  }

  // The `leave_now` Noul: the facts are stated in the question itself, from known state only.
  #leaveQuestion(sit) {
    return {
      type: 'noul',
      instructions:
        `Leave through the portal now (it ends the game)? ${leaveFacts(this.#world, sit)}`,
      criteria: {
        true: 'Leave: little left worth the risk.',
        false: 'Stay: coins or ground still worth getting.',
      },
    };
  }

  // leave_now said leave: make go_to_exit the approach (mid-encounter, the one to resume). Returns the switch.
  #leave(p, step) {
    const memory = this.#memory;
    const a = memory.approach;
    const at = Math.max(step, 1);
    const reason = `Jev decided to leave (${Math.round(p * 100)}%): ${memory.progress.coins} coins held.`;
    addEvent(memory, at, `Decided to leave through the portal (${Math.round(p * 100)}%).`);
    if (isTactic(a.id)) {
      const from = a.interrupted?.id ?? a.id;
      replaceInterrupted(memory, { id: 'go_to_exit', text: APPROACHES.go_to_exit.text }, reason, at);
      return { from, to: 'go_to_exit', reason };
    }
    const from = a.id;
    changeApproach(memory, approachOf('go_to_exit'), at); // leaving is a decision, not a failure: no plan.tried row
    this.#review = { step: at, targetSteps: this.#target('go_to_exit')?.steps ?? null };
    return { from, to: 'go_to_exit', reason };
  }
}
