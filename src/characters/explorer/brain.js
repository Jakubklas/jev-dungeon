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
  APPROACHES, TACTICS, approachTarget, availableApproaches, avoidZone, describeMoveParts, exitSeen, heartTarget, isTactic, leaveFacts, nearbyPiles, situation, tacticFeasibility,
} from './perception.js';
import { dirWord, euclid, isFrontier, key, knownDistances, knownFloor, neighbours, sameCell, step as nextCell } from './known-map.js';
import { cornerFacts, holdGhost, knownLineOfSight, matchup, remarkLine, speedPhrase, threatDistance, threatsOf } from './encounter.js';
import { buildSkillSet, skillConfig } from '../../skills/loadouts.js';
import { pickSkill, skillQuestion } from '../../skills/question.js';
import {
  LIMITS, addEvent, addLandmark, backAndForth, changeApproach, countEncounter, createMemory, interruptApproach, recordStep, replaceInterrupted, resumeApproach, saveMemory, setSentiment, setSkills, switchApproach,
} from './memory.js';
import { GRACE_TICKS } from '../adversary/adversary.js';
import {
  allowedMoods, defaultMood, panicNext, retreatTier, tierOf, tierOfMood, apply as applyConfidence, band as confidenceBand, capability, closeEncounter, combine, createConfidence, seeChase, sightWeight,
} from './confidence.js';
import { askJev, shuffle, jevModel } from '../../jev.js';

let REVIEW_EVERY = 8; // steps between approach reviews
let APPROACH_FAILING = 0.5; // approach_working.noul below this switches approach
let REDECIDE_COOLDOWN = 3; // min ticks between decision steps for a failing tactic
let REMEMBER_STEPS = 30; // a remembered sighting expires after this many steps
const FIRE_LINE = 'Outnumbered with the fire strike ready: use it to break out or clear them at once.';
let SKILL_NEAR = 10; // loose gate (PLAN D7): an opponent visible, or remembered fresh, within this many cells
let SKILL_REMEMBER_STEPS = 10; // a sighting this young still opens the gate
let THREAT_STEPS = 2; // a visible chaser within this many path steps offers the block
// Ghosts get their claw attack in a later phase (PLAN S4). Until then a block has nothing to stop; the
// plan wants it left out, but this phase offers it anyway. Flip to false to hide the block option.
let GHOSTS_CAN_ATTACK = true;
let HOLD_MAX = 5; // engage hold: consecutive ticks the explorer waits 2 steps off a hunting ghost before the normal question returns
let HOLD_ADJACENT_MAX = 2; // ... and ticks it stays beside one without striking (a skill pick below SKILL_MIN)
let CORNER_MODE = 'off'; // cornered by an enemy: off | urgent | ascii | route | full (see PLAN-corner.md)
let PINGPONG_FAILS = 3; // back-and-forth moves under a tactic that make it fail
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
  // Low tier (C <= 35). Panic is entered by code below C 20 and never offered to Jev; its gap is ignored in spirit (1).
  panic: {
    min_gap: 1, end_ticks: 8,
    move_priority: 'Panic: escape danger; resume the portal route.',
    when: 'Entered by code when confidence collapses; never offered as a choice.',
    priority: 'Panic: escape danger, ignoring coins and optional fights. Strike a blocker; reach the portal to win.',
    note: 'Escapes immediate danger to continue toward the portal.',
    skill_priority: 'Strike only an enemy that blocks your only way; otherwise keep running.',
  },
  wary: {
    min_gap: 4, end_ticks: 5,
    move_priority: 'Wary: recover, then advance to the portal.',
    when: 'Upside: recover to advance. Risk: enemies keep hunting. Pick with low confidence, last life or no sword near a chaser.',
    priority: 'Wary: keep 4 steps when possible; heal, ready the sword or reposition, then advance. Distance alone is not progress.',
    note: 'Recovers or repositions, then resumes forward progress.',
    skill_priority: 'Strike adjacent enemies if ready to buy distance; else block an incoming claw.',
  },
  guarded: {
    min_gap: 3, end_ticks: 4,
    move_priority: 'Guarded: find a workable advance.',
    when: 'Upside: less exposure. Risk: avoidance stalls progress. Pick with low confidence when a fight looks bad.',
    priority: 'Guarded: advance toward the portal, keeping 3 steps when possible. Skip optional loot; slip past or regroup for blockers.',
    note: 'Seeks a workable advance; regrouping prepares the next attempt.',
    skill_priority: 'Strike adjacent enemies if ready to buy distance; else block an incoming claw.',
  },
  // Midlow tier (36..49): the one middle tier that pulls back. A retreat for a while, not for good.
  cautious: {
    min_gap: 4, end_ticks: 4,
    move_priority: 'Cautious: regroup, then resume the route.',
    when: 'Upside: a better fight and renewed progress. Risk: enemies keep hunting. Pick when hurt; retreat must improve the next attempt.',
    priority: 'Cautious: heal, ready the sword or reposition, keeping 4 steps if possible; return to the route. Repeated retreat without recovery fails.',
    note: 'Regroups (to a seen heart if hurt), then resumes the interrupted route.',
    skill_priority: 'Strike adjacent enemies if ready; else block an incoming claw.',
  },
  // Midlow and mid tiers (36..69).
  steady: {
    min_gap: 3, end_ticks: 4,
    move_priority: 'Steady: advance; clear manageable enemies.',
    when: 'Upside: progress without detours. Risk: fights cost lives. Pick to follow the route and clear manageable obstacles.',
    priority: 'Steady: explore toward the portal; take coins on the way. Clear manageable enemies; distance prepares a fight, not endless avoidance.',
    note: 'Advances along the route and clears manageable obstacles.',
    skill_priority: 'Strike adjacent enemies if ready; else block an incoming claw.',
  },
  greedy: {
    min_gap: 3, end_ticks: 2,
    move_priority: 'Greedy: loot on the way; seen portal first.',
    when: 'Upside: loot and new rooms. Risk: detours into danger. Pick with coins or unexplored ground, no visible enemy and full lives or hit protection.',
    priority: 'Greedy: take nearby coins and explore; detours are fine until the portal is seen, then reach it. Keep 3 steps unless fighting.',
    note: 'Goes after coins and unexplored rooms; detours are fine.',
    skill_priority: 'Strike adjacent enemies if ready; then carry on looting.',
  },
  // High tier (>= 70).
  bold: {
    min_gap: 2, end_ticks: 1,
    move_priority: 'Bold: clear the way; finish wounded enemies.',
    when: 'Upside: removes enemies and pursuers for good. Risk: claws cost lives. Pick with a ready sword for favourable fights or wounded targets.',
    priority: 'Bold: win favourable fights to clear the way to the portal. Finish wounded enemies; keep 2 steps unless striking or closing on a stunned target.',
    note: 'Takes favourable fights to remove obstacles and pursuers.',
    skill_priority: 'Strike adjacent enemies if ready; close on stunned, wounded targets.',
  },
  fearless: {
    min_gap: 1, end_ticks: 1,
    move_priority: 'Fearless: hunt visible enemies for glory.',
    when: 'Upside: glory and permanent threat removal. Risk: extra claw exposure. Pick with a ready sword to actively hunt rather than wait.',
    priority: 'Fearless: hunt visible enemies for glory, finish wounded targets and strike when ready, even outnumbered. Only the portal wins the game.',
    note: 'Actively hunts visible enemies for glory and accepts extra risk.',
    skill_priority: 'Strike adjacent enemies if ready; pursue the next visible target.',
  },
};
// Moods the sentiment question lists, with the short gloss for its first sentence (panic is never listed).
const TIER_RANK = { low: 0, midlow: 1, mid: 2, high: 3 };
const MOOD_GLOSS = { wary: 'safety (wary)', guarded: 'caution while exploring (guarded)', cautious: 'regrouping (cautious)', steady: 'the plan (steady)', greedy: 'loot (greedy)', bold: 'the fight (bold)', fearless: 'the hunt (fearless)' };
const DEFAULT_SENTIMENT = 'steady';
export const profileOf = (memory) => SENTIMENTS[memory.sentiment?.id] ?? SENTIMENTS[DEFAULT_SENTIMENT];

const profileNote = (id) => {
  const s = SENTIMENTS[id];
  return `min gap ${s.min_gap}; alert ${s.end_ticks} tick${s.end_ticks === 1 ? '' : 's'} after losing sight. ${s.note}`;
};

// The one place Jev is told what self.confidence means (sentiment question only; rules() rides on every request).
export let CAPS_SENTENCE = ' `self.confidence` weighs your lives, sword and the enemies you know against how your fights went; it decides which moods are offered.';

const TRIGGER_TEXT = {
  start: 'The explorer is about to start exploring the dark dungeon.',
  encounter: 'An enemy has just come into sight (or started chasing): the explorer must choose how to deal with it.',
  tactic_failed: 'The current tactic stopped working: its target is gone or the enemy got closer than the minimum gap.',
  chase_over: 'No enemy has been in sight for a while: the encounter is over and exploring resumes.',
  exit: 'The portal (the way out) has just been seen.',
  coins: 'Coins have just come into view nearby.',
  dispelled: 'The explorer has just dispelled an enemy; others may remain.',
  review: 'The explorer just dropped an exploration approach that was not working and switched to another.',
  hit: 'The explorer just lost a life to an enemy: rethink whether to keep at it.',
  confidence: 'Your confidence changed enough that your mood no longer fits: choose again.',
  directive: "The player has just given the explorer an instruction (`directive`): it outranks every mood's `when`.",
};

// The player's text (PLAN-inject): trimmed, whitespace collapsed, control characters out, at most LIMITS.directive chars.
const DIRECTIVE_DEFAULT_STEPS = 20;
const cleanDirective = (t) => String(t ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.directive).trim();
// The first priority line while a directive is live: quoted and labelled as the player's words, safety kept.
const directiveLine = (text) => `Follow the player's directive: ${JSON.stringify(text)}. It outranks the mood and the approach. Never step onto an enemy.`;

// How each tactic should shape the move while an adversary is in sight.
const TACTIC_MOVE_HINT = {
  run_away: 'Keep the distance growing; avoid known dead ends.',
  slip_past: 'Moving toward or alongside it is fine while the gap holds: follow the route past it.',
  engage: 'Go to the target: 2 steps off a hunting enemy, so it steps next to you and you strike first; next to one you stunned.',
  hide: 'Reach the target out of its sight fast; do not step back into its line of sight.',
  race_to_exit: 'Head straight for the portal; getting there first matters most.',
  carry_on: 'It has not seen you: keep exploring, out of its line of sight.',
};

// A function, not a constant: speed, lives and grace come from the tunables in src/settings.js.
// The objective is folded in, so nothing else repeats it.
// combat: null (no attack skill) or { name, damage, cooldown, stun, coinChance, clawCooldown, shield } (the live skill and settings numbers; shield: the block chance, null without a block skill).
const rules = (hasSkills = true, combat = null, directive = false) =>
  'Goal: reach and step through the portal at the dungeon\'s end; only the portal wins. Advance: dispel enemies in your way, permanently removing obstacles and pursuers; slip past when fighting would prevent reaching it. Retreat to recover or reposition, then advance again. Score: coins held when you win. At 0 lives you lose, coins and all. ' +
  'A step is up, down, left, right or stay. Each visited cell lights its surroundings for good: lit cells are known; the rest, and the portal until lit, are not. ' +
  `Enemies chase an explorer they see, at ${speedPhrase()}. ` +
  `A touch only bumps. An adjacent enemy's claw costs ${skillConfig().clawDamage} ${skillConfig().clawDamage === 1 ? 'life' : 'lives'} (you start with ${EXPLORER_LIVES}); after a hit you are safe for ${GRACE_TICKS} steps. ` +
  '`threats.visible`: in sight now, with each health bar (`hp`); `threats.remembered`: seen earlier, frozen where last seen.' +
  (combat ? ` ${combatRule(combat)}` : '') +
  (hasSkills ? ' Besides moving you may use one skill (`self.skills`) per step.' : '') +
  (directive ? ' The player has given you an instruction in `directive`. Follow it above your own plan; it replaces your current objective for as many steps as it says.' : '');

// What a dispel pays, for the tactic priority line: "may drop a coin" (the chance is never stated), nothing at 0.
const engagePays = (p) => `dispelling it permanently removes an obstacle or pursuer on the way to the portal${p > 0 ? ' and may drop a coin' : ''}`;
const chancePhrase = (p) => (p >= 1 ? 'every time' : p === 0.5 ? 'half the time' : `${Math.round(p * 100)}% of the time`);
// What the sword does, with the live numbers: the facts that make a fight worth weighing.
// The "next strike lands first" clause is claimed only while the stun outlasts the sword's cooldown and lasts 2+
// steps (strike, close in, strike again is two ticks): the stubbed duels (check-skills section 12) show a claw in
// between with a 1-step stun at full speed or a sword cooldown of 3 against a 2-step stun.
const stunHolds = (stun, cooldown) => stun >= 2 && cooldown < stun;
function combatRule({ name, damage, cooldown, stun, coinChance, clawCooldown, shield }) {
  const loot = coinChance > 0 ? ' and may drop a coin' : ''; // the chance is never stated (user decision)
  return `Your ${name.toLowerCase()} always hits an adjacent enemy: it loses ${damage} hp${stun ? ` and is knocked back and stunned ${stun} step${stun === 1 ? '' : 's'}` : ''}` +
    `${stunHolds(stun, cooldown) ? ', so your next strike lands before it can claw' : ''}; at 0 hp it is gone for good${loot}. ` +
    `An enemy's claw needs ${clawCooldown} step${clawCooldown === 1 ? '' : 's'} to recharge` +
    `${shield > 0 ? `, and your shield stops it ${chancePhrase(shield)}` : ''}.`;
}

// Encounter sentences that repeat a tactic option's own fact (dropped when the tactic question is asked).
const TACTIC_FACT_KEYS = ['slip_past', 'hide', 'run_away', 'exit'];
let HEAL_NEAR = 12; // when hurt but above half the lives, a seen heart this many known-path steps away or less starts `heal`
let COIN_NEAR = 8; // a newly seen pile this many known-path steps away or less can start a coin decision
let COIN_EVERY = 10; // min steps between coin decisions
let COIN_SWITCH = 0.5; // the coin decision's next_approach pick must reach this probability to switch
let DIRECTIVE_DONE = 0.5; // directive_done.noul above this ends the player's directive early (PLAN-inject I4)
let DIRECTIVE_ASK_EVERY = 5; // steps between two directive_done questions
let LEAVE_NOW = 0.5; // leave_now.noul above this switches the approach to go_to_exit
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
  #dirAskStep = 0; // the step the directive was set or directive_done last asked
  #leaveDue = false; // legacy leave_now scheduling; portal discovery now commits the destination
  // { id, cell }: the goal cell of the current tactic, kept so its target stays put.
  #tacticGoal = null;
  // { id, cell }: a deliberately chosen exploration or recovery destination. An encounter may
  // interrupt the approach, but it must not make Jev forget the frontier or heart it was crossing
  // known ground to reach.
  #approachGoal = null;
  // cornerMode: this tick's cornerFacts (null = not cornered / off), and the breakout route kept for its length
  // ({ cell, until } with the route cell and the last step it is kept to; route and full only).
  #corner = null;
  #route = null;
  // Cells a tactic must not target any more: set when a ping-pong made the tactic fail (the cells it
  // bounced between and the target that led there), so the re-decision is a different one. Cleared
  // when the encounter starts or ends.
  #exclude = null;
  // id -> { id, cell, step, chasing, hp, maxHp }: adversaries this explorer SAW (health bar included), frozen at the last sighting.
  // Built only from visibleAdversaries(); expired by age or by seeing the empty cell.
  #seen = new Map();
  // PLAN-levels: the explorer's one-line remark on a monster it has just sighted (null otherwise), and how many of each
  // kind it has made (the pool is walked in order: deterministic, no rng). Reset at the start of every takeTurn.
  #remark = null;
  #remarkN = { weak_target: 0, too_strong: 0 };
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
  #cs = null;
  #csLast = 50;
  #csWhy = [];
  // Confidence caps (PLAN-confidence-mood, confidence: 'caps'): C = capability + history decides which moods the sentiment question
  // lists. #capFired = the directions ('up' wary closed, 'down' bold or greedy closed) whose `confidence` trigger already fired
  // this encounter; #visibleIds = the ids in sight at the start of this tick (for the weights).
  #fixedMood = false; // arm { fixedMood: true } (duel harness): the four classic moods stay offered, so the hold and the request sizes can be measured without C moving the mood
  #wExtra; // capability()'s wPerExtra override (undefined = the default)
  #capFired = new Set();
  #visibleIds = new Set();

  constructor(world, { ask = null, memoryDir = null, skills = 'explorer', hold = 'multi', confidence = false } = {}) {
    this.#wExtra = confidence && typeof confidence === 'object' ? confidence.wPerExtra : undefined; // arm object only: the measurement compares W_PER_EXTRA 0.35 and 0.5
    this.#fixedMood = confidence?.fixedMood === true;
    this.#holdOn = hold; // 'multi' (default) also holds against 2-3 enemies; true = one enemy only, false = no hold (the duel checks that prove what the hold buys, P7a)
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
    this.#pinApproachGoal('nearest_frontier');
    this.#review = { step: 0, targetSteps: this.#target('nearest_frontier')?.steps ?? null };
    memory.progress.known_floor_cells = world.knownFloorCount();
    this.#encounter.pending = 'start';
    this.#cs = createConfidence(confidence && typeof confidence === 'object' ? confidence : {}); // an arm object = start / weights / model (checks and measurements)
    this.#syncConfidence();
    this.#csLast = this.#capState().C;
  }

  // Applies one confidence event with the lives left now (own state: fog-safe) and mirrors the result into memory.
  #confide(type, n = 1) {
    this.#cs = applyConfidence(this.#cs, type === 'coin' ? { type, n } : type, this.#world.health, this.#world.maxHealth);
    this.#csWhy.push(type);
    this.#syncConfidence();
  }

  // Caps mode: { R capability, H history, C, ctx } now, from own lives, the live skill numbers and the brain's sightings (visible
  // weight 1, remembered via sightWeight), all fog-safe; a ghost never seen is not in #seen.
  #capState() {
    const world = this.#world;
    const k = this.#skills.skills.find((x) => x.kind === 'attack');
    const cfg = skillConfig();
    const ghosts = [...this.#seen.values()].map((r) => ({ hp: r.hp ?? r.maxHp ?? 2, weight: this.#visibleIds.has(r.id) ? 1 : sightWeight(world.steps - r.step) }));
    const R = capability({
      lives: world.health, maxLives: world.maxHealth, clawDamage: cfg.clawDamage, swordDamage: k?.damage ?? 1,
      armed: !!k, ghosts,
    }, this.#wExtra);
    const H = this.#cs.value;
    const C = combine(R, H, world.health, world.maxHealth);
    const swordDown = !!k && !this.#armed() && threatsOf(world).some((th) => th.chasing && threatDistance(th, world.pos) <= 3);
    return { R, H, C, ctx: { lastLife: world.health <= cfg.clawDamage, swordDown } };
  }

  // The moods the sentiment question lists at C (caps mode), the current mood kept by the hysteresis.
  #allowed(cap = this.#capState()) {
    if (this.#fixedMood) return ['wary', 'steady', 'greedy', 'bold']; // the four classic moods, C never moves them
    return allowedMoods(cap.C, { ...cap.ctx, current: this.#memory.sentiment?.id ?? null });
  }

  // The current mood's profile at the current C (all gap readers below use it, never SENTIMENTS directly).
  #profile() {
    const p = profileOf(this.#memory);
    return p;
  }

  // self.confidence as Jev reads it: "<floor C> <band>" (caps: C = capability + history; else the history score).
  #confidenceWord() {
    const c = this.#capState().C;
    return `${Math.floor(c)} ${confidenceBand(c)}`;
  }

  #syncConfidence() {
    this.#memory.progress.confidence = { value: this.#cs.value, now: this.#capState().C, counts: { ...this.#cs.counts } }; // value = history H, now = C
  }

  // The turn's `confidence` object for the UI: value, band word, change since the last report and why.
  #confidenceReport() {
    const cap = this.#capState();
    const value = cap.C;
    const why = [...new Set(this.#csWhy)];
    const reason = why.filter((w) => w !== 'regen').join(', ') || null; // regen alone is not an event
    const delta = Math.round((value - this.#csLast) * 100) / 100;
    this.#csLast = value;
    this.#csWhy = [];
    return { value, band: confidenceBand(value), delta, reason, capability: cap.R, history: cap.H, tier: tierOf(value, tierOfMood(this.#memory.sentiment?.id)), panic: this.#memory.sentiment?.id === 'panic' };
  }

  // Own shield stopped a claw (called by turn.js from the 'blocked' event) and saves.
  async noteBlocked() {
    this.#confide('blocked');
    await this.#save();
  }

  get memory() {
    return this.#memory;
  }

  // What the explorer said about a monster it first sighted this turn ("Ah, that's a weak target." / "I don't have enough
  // health to fight this guy."), or null. Shown once per sighting; never part of a request.
  get remark() {
    return this.#remark;
  }

  // The player's live instruction (PLAN-inject): null or { text, from_step, until_step, steps_left }. Lives in game
  // steps: from_step is the first step it applies to, until_step the last; steps_left counts the steps still to take.
  #directiveExpired() {
    const d = this.#memory.directive;
    return !!d && d.until_step - this.#world.steps <= 0;
  }

  get directive() {
    const d = this.#memory.directive;
    if (!d || this.#memory.sentiment?.id === 'panic') return null; // panic cannot be overridden: a whisper waits (and still runs out) until it ends
    const steps_left = d.until_step - this.#world.steps;
    return steps_left > 0 ? { text: d.text, from_step: d.from_step, until_step: d.until_step, steps_left } : null;
  }

  // Sets (or, with empty text, clears) the directive. The caller sanitises; it is clamped again here. A new one
  // replaces the live one and queues one `directive` decision (merged under the one-sentiment-call rule).
  setDirective(text, { steps = DIRECTIVE_DEFAULT_STEPS } = {}) {
    const t = cleanDirective(text);
    if (!t) { this.clearDirective('cleared by the player'); return null; }
    const n = Number.isFinite(steps) && steps >= 1 ? Math.floor(steps) : DIRECTIVE_DEFAULT_STEPS;
    const at = Math.max(this.#world.steps, 1);
    if (this.directive) addEvent(this.#memory, at, 'Directive ended: replaced by a new one.');
    this.#memory.directive = { text: t, from_step: this.#world.steps + 1, until_step: this.#world.steps + n };
    addEvent(this.#memory, at, `Heard: ${t}`);
    this.#dirAskStep = this.#world.steps;
    this.#encounter.pending ??= 'directive';
    return this.directive;
  }

  // Ends the directive (no-op without one), logs why and lets the parked approach start fresh.
  clearDirective(reason = 'cleared') {
    const m = this.#memory;
    if (!m.directive) return;
    const was = m.directive; // (not the getter: on expiry steps_left is already 0)
    m.directive = null;
    if (this.#encounter.pending === 'directive') this.#encounter.pending = null;
    addEvent(m, Math.max(this.#world.steps, 1), `Directive ended: ${String(reason).slice(0, 80)}.`);
    if (was && !isTactic(m.approach.id) && APPROACHES[m.approach.id]) { // resumed with fresh counters and no plan.tried row
      changeApproach(m, approachOf(m.approach.id), this.#world.steps);
      this.#review = { step: this.#world.steps, targetSteps: this.#target(m.approach.id)?.steps ?? null };
    }
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
    const body = JSON.stringify({ model: jevModel(), state, questions });
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
    const live = this.directive;
    // While a directive is live the approach is shown as parked (unless a tactic already parked it).
    const parked = live && !isTactic(a.id) ? { id: a.id, since_step: a.since_step, reason: 'player directive' } : null;
    return {
      game: rules(this.#skills.size > 0, this.#combat(), Boolean(live)),
      ...(live ? { directive: { text: live.text, steps_left: live.steps_left, from_step: live.from_step } } : {}),
      self: { ...sit.self, confidence: this.#confidenceWord(), ...(this.#skills.size ? { skills: skillStates(this.#skills.summaries()) } : {}), mind: { id: m.sentiment.id, since_step: m.sentiment.since_step, recent: mindRuns(m.sentiment_history) } },
      surroundings: this.#corner && (CORNER_MODE === 'ascii' || CORNER_MODE === 'full') && this.#corner.diagram?.length
        ? { ...sit.surroundings, local_map: this.#corner.diagram, ...(moves ? { moves } : {}) }
        : moves ? { ...sit.surroundings, moves } : sit.surroundings,
      threats: tactics && sit.threats.encounter ? { ...sit.threats, encounter: withoutKeys(sit.threats.encounter, TACTIC_FACT_KEYS) } : sit.threats,
      plan: {
        approach: parked
          ? { id: 'directive', current: "Follow the player's directive (`directive`).", since_step: live.from_step, interrupted: parked }
          : { id: a.id, current: a.current, since_step: a.since_step, interrupted: i ? { id: i.id, since_step: i.since_step, reason: i.reason } : null },
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
    this.#visibleIds = visible;
    this.#remark = null;
    const damage = this.#skills.skills.find((x) => x.kind === 'attack')?.damage;
    for (const v of world.visibleAdversaries()) {
      visible.add(v.id);
      this.#everSeen.add(v.id);
      if (!this.#seen.has(v.id) && !this.#remark) { // a new sighting (never seen, or the last one has expired)
        const fit = matchup(world, v, damage);
        const kind = fit === 'weak' ? 'weak_target' : fit === 'too_strong' ? 'too_strong' : null;
        if (kind) this.#remark = remarkLine(kind, this.#remarkN[kind]++);
      }
      this.#seen.set(v.id, { id: v.id, cell: [...v.pos], step: now, chasing: v.mode === 'chase', hp: v.hp, maxHp: v.maxHp, level: v.level, clawDamage: v.clawDamage });
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
      visibleOpponents: visible.map((v) => ({ id: v.id, pos: [...v.pos], mode: v.mode, distance: v.distance, hp: v.hp, maxHp: v.maxHp, stun: v.stun })),
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
  // only: no hidden enemy state or total count reaches the request.
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
  // it without a strike; a stunned or patrolling ghost, a second adversary in sight (unless hold is 'multi': then 2-3 in
  // sight and the nearest hunting unstunned one counts; 4 or more never hold) or no sword keep the normal path.
  // Fog-safe: visible adversaries, the explorer's own strike record and its own sword only.
  #holding() {
    const world = this.#world;
    const h = this.#hold;
    const stop = () => { this.#hold = { cell: null, n: 0, adj: 0 }; return false; };
    if (!this.#holdOn || this.#memory.approach.id !== 'engage' || !this.#armed() || this.#memory.sentiment.id === 'panic') return stop();
    const threats = threatsOf(world);
    const stunned = this.#stunnedIds();
    const th = holdGhost(threats, stunned, world.pos, this.#holdOn === 'multi');
    if (!th) return stop();
    if (approachTarget(world, 'engage', { stunned, cornered: Boolean(this.#cornerOpt()) })?.steps !== 0) return stop();
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
    const remembered = this.#approachGoal?.id === id ? this.#approachGoal.cell : null;
    const target = approachTarget(this.#world, id, { avoid: this.#zone, cornered: Boolean(this.#cornerOpt()), goal: remembered, ...opts });
    // A reached heart / lit frontier is no longer a valid destination. Drop the old commitment so
    // the next current-approach pass can choose a fresh one.
    if (remembered && (!target || !sameCell(target.cell, remembered))) this.#approachGoal = null;
    return target;
  }

  #pinApproachGoal(id) {
    if (isTactic(id) || id === 'go_to_exit') { this.#approachGoal = null; return null; }
    const target = approachTarget(this.#world, id, { avoid: this.#zone, cornered: Boolean(this.#cornerOpt()) });
    this.#approachGoal = target ? { id, cell: [...target.cell] } : null;
    return target;
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
      this.#pinApproachGoal('nearest_frontier');
      this.#review = { step: Math.max(prev, 1), targetSteps: this.#target('nearest_frontier')?.steps ?? null };
      policy = { from: 'collect_coins', to: 'nearest_frontier', reason: 'no seen coins left to collect' };
    }
    // Hearts (hurt only): heal ends when full or no heart is reachable any more; and a quiet moment with a heart in reach starts it.
    // Need sets the reach: at half the lives or fewer any known heart is worth the walk, otherwise only one close by.
    if (memory.approach.id === 'heal' && !this.#target('heal')) {
      changeApproach(memory, approachOf('nearest_frontier'), prev); // not a failure: no plan.tried row
      this.#pinApproachGoal('nearest_frontier');
      this.#review = { step: Math.max(prev, 1), targetSteps: this.#target('nearest_frontier')?.steps ?? null };
      policy = { from: 'heal', to: 'nearest_frontier', reason: world.health >= world.maxHealth ? 'lives are full' : 'no seen heart left to reach' };
    } else if (!policy && !this.directive && !isTactic(memory.approach.id) && !['heal', 'go_to_exit'].includes(memory.approach.id) && !this.#leaving() &&
      !world.visibleAdversaries().length && world.health < world.maxHealth) {
      const heart = heartTarget(world, knownDistances(world, world.pos));
      if (heart && (world.health * 2 <= world.maxHealth || heart.steps <= HEAL_NEAR)) {
        const from = memory.approach.id;
        changeApproach(memory, approachOf('heal'), prev);
        this.#approachGoal = { id: 'heal', cell: [...heart.cell] };
        this.#review = { step: Math.max(prev, 1), targetSteps: heart.steps };
        policy = { from, to: 'heal', reason: `hurt (${world.health} of ${world.maxHealth} lives) and a heart is ${heart.steps} steps away` };
      }
    }
    // A frontier can cease to be an edge after the last move revealed its surroundings. Commit a
    // replacement only for the current approach; candidate approaches in a review remain dynamic.
    if (!isTactic(memory.approach.id) && memory.approach.id !== 'go_to_exit' && !this.#goal()) this.#pinApproachGoal(memory.approach.id);
    if (this.#directiveExpired()) this.clearDirective('ran out of steps'); // defensive: normally ended at the end of its last step
    const liveDirective = this.directive;
    const sit = situation(world, { remembered: this.#remembered, landmarks: memory.landmarks }); // computed before the move: what Jev sees this tick
    this.#watchCorner(sit);
    const enc = this.#encounterPolicy(sit, prev);
    policy = enc.policy ?? policy;

    const legal = world.availableMoves();
    if (!legal.length) throw new Error('No legal moves');
    const forced = legal.length === 1;
    const inSight = sit.threats.visible.length > 0;
    const skillOptions = this.#skillOptions(); // computed before the move, like the facts Jev reads

    // A decision without an adversary in sight waits for the next tick with a real choice. When an
    // encounter starts on the same tick as a pending decision (start, exit, review), the
    // encounter trigger wins and the pending one is dropped: one sentiment call, not two.
    let trigger = enc.trigger ?? info.pending;
    // Confidence caps: the current mood fell outside what C allows (past the hysteresis band). Ghost in sight: one `confidence`
    // decision per direction per encounter (a trigger already due serves instead, and counts). Nothing in sight: a silent swap
    // to steady, no call and no memory event.
    {
      const cap = this.#capState();
      const cur = memory.sentiment.id;
      const list = this.#allowed(cap);
      const wasPanic = cur === 'panic';
      if (!this.#fixedMood && panicNext(cap.C, wasPanic) !== wasPanic) { // PLAN-moods: panic starts below C 20 and ends at 25, by code, no sentiment call
        const to = wasPanic ? defaultMood(list) : 'panic';
        setSentiment(memory, { id: to }, step);
        policy = { from: cur, to, reason: `confidence ${Math.floor(cap.C)}` };
        if (to === 'panic' && inSight) trigger ??= 'confidence'; // the tactic question follows (run away, or the portal), no mood call
      } else if (!wasPanic && !list.includes(cur)) {
        const dir = TIER_RANK[tierOfMood(cur)] < TIER_RANK[tierOf(cap.C, tierOfMood(cur))] ? 'up' : 'down';
        if (inSight) {
          if (!this.#capFired.has(dir) && (trigger || step - info.lastDecision >= REDECIDE_COOLDOWN)) { this.#capFired.add(dir); trigger ??= 'confidence'; }
        } else {
          const to = defaultMood(list);
          setSentiment(memory, { id: to }, step);
          policy = { from: cur, to, reason: `confidence ${Math.floor(cap.C)}` };
        }
      }
    }
    // Coins in view with no other decision due: ask the mood first (greedy may fit), then next_approach below.
    // Same gates as askCoins; the 10-step cap is #coinStep (set when a coin decision runs).
    if (!trigger && !liveDirective && this.#coinDue && !forced && !inSight && !isTactic(memory.approach.id) && memory.approach.id !== 'collect_coins' && !this.#leaving() && !this.#leaveDue &&
      step - info.lastDecision >= REDECIDE_COOLDOWN && !(step - this.#review.step >= REVIEW_EVERY && memory.progress.steps_since_approach >= REVIEW_EVERY)) trigger = 'coins';
    if (trigger && forced && !inSight) {
      info.pending = trigger;
      trigger = null;
    } else {
      info.pending = null;
    }

    let decision = null;
    let tacticIds = []; // feasible tactics Jev chooses between in request 2
    let decisionTargets = {}; // tactic id -> observed target at decision time
    let apiMs = 0;
    if (trigger) {
      info.lastDecision = step;
      const sentiment = await this.#askSentiment(sit, trigger);
      apiMs += sentiment.ms;
      const profile = this.#profile();
      decision = { trigger, sentiment: { choice: sentiment.choice, probabilities: sentiment.probabilities }, tactic: null, apiMs: sentiment.ms };
      if (inSight) {
        const feasible = tacticFeasibility(world, profile.min_gap, { exclude: this.#exclude, armed: this.#armed(), stunned: this.#stunnedIds(), fight: this.#fight(), panic: memory.sentiment.id === 'panic', heartRun: this.#heartRun(memory), retreat: this.#retreatOK(memory.sentiment.id), cornered: this.#cornerOpt() });
        decisionTargets = Object.fromEntries(Object.entries(feasible).map(([id, f]) => [id, f.target]));
        const options = Object.fromEntries(TACTICS.filter((id) => feasible[id]).map((id) => [id, `${APPROACHES[id].brief} ${feasible[id].fact}`]));
        tacticIds = Object.keys(options);
        if (tacticIds.length === 1) {
          // Only one way to deal with it: code takes it, no one-option Choice.
          this.#applyTactic(tacticIds[0], trigger, prev, decisionTargets[tacticIds[0]].cell);
          decision.tactic = { choice: tacticIds[0], probabilities: { [tacticIds[0]]: 1 }, options };
          tacticIds = [];
        } else if (tacticIds.length) {
          decision.tactic = { choice: null, probabilities: null, options };
        }
      }
    }

    const profile = this.#profile();
    this.#keepEscapeGoal(profile);
    this.#keepRouteGoal();
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
    const loneEngage = !liveDirective && tacticIds.includes('engage') && this.#fightOn(sit) &&
      (memory.sentiment.id === 'steady' || memory.sentiment.id === 'greedy');
    if (tacticIds.length) {
      questions.tactic = {
        type: 'choice',
        instructions: {
          question:
            `${TRIGGER_TEXT[trigger]} Which tactic? Feeling ${memory.sentiment.id} (\`self.mind\`), the explorer keeps enemies ` +
            `${profile.min_gap}+ steps away: only tactics allowing that are listed${this.#cornerOpt() ? ' (cornered: slip past is listed whatever the gap)' : ''}. Judge from \`threats\`.`,
          priorities: liveDirective
            ? [directiveLine(liveDirective.text), 'Pick the tactic that best serves the directive without breaking the safety rule; reaching and stepping through the portal wins the game.']
            : loneEngage
            ? [
              ...this.#cornerTacticLine(),
              sit.threats.visible.length > 1
                ? 'Default: engage while the sword is ready (you act first; hold off the nearest). Run away when cramped or without the sword.'
                : 'Default: engage a lone enemy while the sword is ready (you act first). Run away when cramped or without the sword.',
              profile.priority,
              'Prefer a tactic that keeps making progress (slip past, carry on); reaching and stepping through the portal wins the game.',
            ]
            : [
              ...this.#cornerTacticLine(),
              ...(this.#cornerOpt() ? [] : [profile.priority]),
              'Prefer a tactic that keeps making progress (slip past, carry on); reaching and stepping through the portal wins the game.',
              'Engage while the sword is ready: hold 2 steps off the nearest enemy so it steps in and you strike first; the slower ones come later. Run away when cramped or without the sword.',
            ],
        },
        criteria: Object.fromEntries(shuffle(tacticIds).map((id) => [id, decision.tactic.options[id]])),
      };
      if (!forced) {
        for (const id of tacticIds) {
          const q = this.#moveQuestion(id, sit, profile, true, hasSkillOptions, decisionTargets[id]);
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
    const reviewTarget = this.#target(approachId);
    // A recovery trip may cross a long, fully lit corridor. Each step that closes that committed
    // route is real progress, even before it reveals a new cell, so do not ask Jev to abandon it.
    const closingCommittedRoute = approachId === 'heal' && reviewTarget && rInfo.targetSteps !== null && reviewTarget.steps < rInfo.targetSteps;
    if (closingCommittedRoute) this.#review = { step, targetSteps: reviewTarget.steps };
    // No reviews while a tactic or the run for the portal is on: those last as long as the situation does.
    const reviewDue =
      !forced && !liveDirective && !tacticIds.length && approachId !== 'go_to_exit' && !isTactic(approachId) &&
      !closingCommittedRoute && sinceReview >= REVIEW_EVERY && memory.progress.steps_since_approach >= REVIEW_EVERY;
    if (reviewDue) this.#addReviewQuestions(questions, approachId, rInfo);
    // Legacy leave_now fallback for a known portal without a committed destination.
    // Never while leaving is already the plan, and not beside a tactic question (race_to_exit covers
    // leaving under threat; that request is the largest): it waits for the next tick, a tactic may be on.
    const askLeave = !forced && !liveDirective && !tacticIds.length && exitSeen(world) && !this.#leaving() && (this.#leaveDue || reviewDue);
    if (askLeave) {
      this.#leaveDue = false;
      questions.leave_now = this.#leaveQuestion(sit);
    }
    // Coin decision: a new pile came into view nearby. next_approach, in this tick's request, after the sentiment call
    // (only on a decision tick: the `coins` trigger asked the mood just before, or another trigger's call serves). Not beside a tactic, a review or leave_now (they are the big requests); it waits.
    const askCoins = !liveDirective && this.#coinDue && !!trigger && !forced && !tacticIds.length && !reviewDue && !askLeave && !isTactic(approachId) &&
      approachId !== 'collect_coins' && !this.#leaving();
    if (askCoins) {
      this.#coinDue = false;
      this.#coinStep = step;
      questions.next_approach = this.#nextApproachQuestion(
        availableApproaches(world).filter((id) => id !== 'go_to_exit'),
        'Coins have come into view (`surroundings.coins`). Which approach should the explorer follow now? Keep `plan.approach.current` unless going for the coins is worth the detour (enemies, `threats.remembered`, what is left to explore).',
      );
    }
    // directive_done (Noul): an early end for "until relevant". Rides on a request that is made anyway (never the
    // tactic request, the largest; never a forced tick), at most once per DIRECTIVE_ASK_EVERY steps.
    const askDone = !!liveDirective && !forced && !tacticIds.length && step - this.#dirAskStep >= DIRECTIVE_ASK_EVERY;
    if (askDone) {
      this.#dirAskStep = step;
      questions.directive_done = {
        type: 'noul',
        instructions: `Is the player's directive (${JSON.stringify(liveDirective.text)}) done or no longer relevant, so the explorer can go back to its own plan? Judge from \`surroundings\` and \`recent\`.`,
        criteria: { true: 'Done: it was achieved, or cannot be anymore.', false: 'Not done: keep following it.' },
      };
    }
    // ONE skill question per request (never per tactic, never in the sentiment request). On a forced tick
    // it is the only question: a skill-only request (PLAN D4-a).
    // The fire strike is offered only when outnumbered, which is when the low moods say "keep running": one clause, sent only
    // with that option on the question, says the blast is the way to break out (other requests stay byte-identical).
    const fireLine = !liveDirective && 'fire_strike' in skillOptions ? ` ${FIRE_LINE}` : '';
    const skillQ = hasSkillOptions ? skillQuestion(skillOptions, (liveDirective ? directiveLine(liveDirective.text) : profile.skill_priority) + fireLine, { neutral: true }) : null;
    if (skillQ) questions.skill = skillQ;

    let dir = held ? STAY : legal[0];
    let moveDecision = null;
    let review = null;
    let pendingSwitch = null;
    let pendingLeave = null;
    let doneNow = false;
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
        this.#applyTactic(chosen, trigger, prev, decisionTargets[chosen].cell);
        moveKey = `move_if_${chosen}`;
        moveFor = chosen;
      }
      const a = answers[moveKey];
      if (!forced && a) {
        dir = legal.includes(a.choice) ? a.choice : legal[0];
        // The skill and move answers arrive together. Do not let a bare movement choice walk
        // into a claw that the explorer knows will take every remaining life before its sword can
        // land; hold position and let the tactic be reconsidered instead.
        if (this.#lethalWalkIn(dir, skillKey) && legal.includes(STAY)) dir = STAY;
        moveDecision = { choice: dir, probabilities: a.probabilities, confidence: a.confidence, options: moveOptions[moveFor] };
      }

      const done = askDone ? answers.directive_done?.noul : null;
      if (typeof done === 'number' && done > DIRECTIVE_DONE) doneNow = true;

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
    if (decision) decision.apiMs = apiMs;
    // (apiMs is the whole decision tick: sentiment + tick request)

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
    // A portal destination outranks incidental coin detours and ordinary reviews.
    if (pendingLeave !== null && !result.won) policy = this.#leave(pendingLeave, world.steps);
    else if (pendingCoins && !result.won && !this.#leaving() && !isTactic(memory.approach.id)) {
      const from = memory.approach.id;
      const reason = `Coins came into view: Jev picked ${pendingCoins.id} (${Math.round(pendingCoins.p * 100)}%).`;
      changeApproach(memory, approachOf(pendingCoins.id), world.steps); // a coin detour is not a failure: no plan.tried row
      this.#pinApproachGoal(pendingCoins.id);
      addEvent(memory, world.steps, `Switched from ${from} to ${pendingCoins.id} ${pendingCoins.id === 'collect_coins' ? 'for' : 'with'} the coins in view.`);
      this.#review = { step: world.steps, targetSteps: this.#target(pendingCoins.id)?.steps ?? null };
      policy = { from, to: pendingCoins.id, reason };
    }
    else if (pendingSwitch && !result.won && !this.#leaving() && !isTactic(memory.approach.id)) {
      const from = memory.approach.id;
      switchApproach(memory, approachOf(pendingSwitch.id), pendingSwitch.reason, world.steps);
      this.#pinApproachGoal(pendingSwitch.id);
      addEvent(memory, world.steps, `Dropped ${from} for ${pendingSwitch.id} after a review (judged ${Math.round(pendingSwitch.working * 100)}% working).`);
      this.#review = { step: world.steps, targetSteps: this.#target(pendingSwitch.id)?.steps ?? null };
      info.pending = info.pending ?? 'review'; // the new approach gets its sentiment next tick
    }
    if (result.won) addEvent(memory, world.steps, result.moved ? `Stepped through the portal with ${world.coins === 1 ? '1 coin' : `${world.coins} coins`}.` : 'Cleared the portal-less arena.');
    this.#skills.turnPassed();
    if (doneNow && this.directive) this.clearDirective('Jev judged it done');
    if (this.#directiveExpired()) this.clearDirective('ran out of steps'); // its last step was just taken
    {
      // Own pickups raise C (coins +D_COIN each; a heart +D_HEART, applied after the heal so the lives cap sees the restored life).
      // Regen pulls C toward the start (after REGEN_WAIT quiet ticks), every tick. Being chased costs nothing: it justifies no drop.
      if (result.coins) this.#confide('coin', result.coins);
      if (result.healed) this.#confide('heart');
      this.#confide('regen');
    }
    this.#syncConfidence(); // memory.progress.confidence.now follows sightings too, not only events
    await this.#save();

    return {
      step: world.steps, dir, forced: moveDecision === null, revealed: result.revealed, won: result.won,
      directive: this.directive,
      move_decision: moveDecision, held, decision, review, policy, skill_decision: skillDecision, skill_events: this.#skillEvents, apiMs,
      confidence: this.#confidenceReport(),
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
        if (e.staggered !== false) this.#struck.set(e.id, step); // a monster the blow did not stagger is not stunned: do not wait on it
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
      addLandmark(memory, { kind: 'hiding_spot_used', cell: here, step, note: "Hid here, out of an enemy's sight." });
    }
  }

  // PLAN-moods: is a fight worth talking up? The sword is ready, the explorer is not panicking or in the low tier, and it is a single
  // monster, a hurt one, or confidence in the high tier / a mood that wants the fight (bold, fearless). No counts of enemies, hp or claws: Jev gets the specs
  // (hp bars, the sword's numbers) and decides. Reads only the explorer's own state and the hp bars in sight.
  // The moods that pull back: low tier, panic and midlow's cautious. Hurt with a heart in reach, run_away heads for it
  // (perception.js tacticFeasibility), so a retreat also regroups lives.
  #heartRun(memory) {
    const id = memory.sentiment?.id;
    return id === 'panic' || id === 'cautious' || tierOfMood(id) === 'low';
  }

  // May the tactic menu offer pulling back (run_away, hide, race_to_exit) beside a forward tactic? Only when confidence is really
  // lower: panic, a low-tier or midlow mood (wary, guarded, cautious), or C in the low / midlow tier (a last life or a chaser close
  // by with the sword down count as low). In mid and high Jev leans on any safe option shown, so it is kept for the cornered case.
  #retreatOK(id = this.#memory.sentiment?.id, cap = this.#capState()) {
    if (this.#fixedMood || id === 'panic' || retreatTier(tierOfMood(id))) return true; // fixedMood: C moves no menu, the classic one stays
    if (this.directive) return true; // the player's instruction outranks the mood: every way of dealing with the enemy stays open
    if (cap.ctx.lastLife || cap.ctx.swordDown) return true;
    if (this.#world.visibleAdversaries().length > 3) return true; // more than the engage hold covers (holdGhost: 3 at most)
    return retreatTier(tierOf(cap.C, tierOfMood(this.#memory.sentiment?.id)));
  }

  #fightOn(sit) {
    const id = this.#memory.sentiment.id;
    if (id === 'panic' || !this.#armed() || !sit.threats.visible.length) return false;
    const cap = this.#capState();
    const tier = cap.ctx.lastLife ? 'low' : tierOf(cap.C, tierOfMood(id)); // a last life forces the low tier
    if (tier === 'low') return false;
    if (tier === 'high' || id === 'bold' || id === 'fearless') return true;
    return sit.threats.visible.length === 1 || this.#world.visibleAdversaries().some((v) => v.hp < v.maxHp);
  }

  // The encounter's stakes in one sentence, only for a #fightOn. Otherwise ''.
  #stakes(sit, trigger) {
    if (!['encounter', 'tactic_failed', 'hit', 'confidence'].includes(trigger) || !this.#fightOn(sit)) return '';
    if (sit.threats.visible.length > 1) return ' Holding off the nearest and striking first, each dispel removes an enemy for good; running may leave them hunting you.';
    return ' A single enemy you strike first costs little and a dispel removes it for good; running may leave it hunting you.';
  }

  // Request 1 of a decision step. Sets memory.sentiment and returns { choice, probabilities, ms }.
  async #askSentiment(sit, trigger) {
    const world = this.#world;
    const memory = this.#memory;
    if (memory.sentiment.id === 'panic') return { choice: 'panic', probabilities: { panic: 1 }, ms: 0 }; // panic is code's, not Jev's, until C is back at PANIC_EXIT
    const caps = this.#capState();
    const ids = this.#allowed(caps);
    if (ids.length === 1) { // only one mood left: code takes it, no one-option Choice
      setSentiment(memory, { id: ids[0] }, world.steps + 1);
      return { choice: ids[0], probabilities: { [ids[0]]: 1 }, ms: 0 };
    }
    const inSight = sit.threats.visible.length > 0;
    // With an adversary in sight, each mood also says which tactics its minimum gap leaves open here.
    const allowed = new Map(); // `${min_gap}|${retreat}` -> the tactic names that mood would see
    const leaves = (id) => {
      const g = SENTIMENTS[id].min_gap;
      const retreat = this.#retreatOK(id, caps);
      const k = `${g}|${retreat}`;
      if (!allowed.has(k)) allowed.set(k, Object.keys(tacticFeasibility(world, g, { exclude: this.#exclude, armed: this.#armed(), stunned: this.#stunnedIds(), retreat })).map((t) => t.replace(/_/g, ' ')));
      return allowed.get(k);
    };
    const criteria = Object.fromEntries(shuffle(ids).map((id) => {
      const s = SENTIMENTS[id];
      const here = inSight ? ` Tactics it leaves here: ${leaves(id).join(', ') || 'none, only luck'}.` : '';
      return [id, `${s.when} Effect: ${profileNote(id)}${here}`];
    }));
    const questions = {
      sentiment: {
        type: 'choice',
        instructions:
          `${TRIGGER_TEXT[trigger]}${this.#stakes(sit, trigger)} ${caps ? `Which stance best helps the explorer advance to the portal through this situation? Only the moods your confidence allows are listed: ${ids.map((id) => MOOD_GLOSS[id]).join(', ')}.` : 'Which stance best helps the explorer advance to the portal: wary, steady, greedy or bold?'} ` +
          'The mood sets how close enemies may come (min gap) and how long it stays alert after losing sight of them. Judge from `surroundings`, ' +
          '`threats` (in sight, remembered, encounter), `recent` and `self.mind`. Pick a stance for progress: clearing an enemy permanently removes a pursuer; regrouping should enable renewed advance.' +
          CAPS_SENTENCE +
          (this.directive ? " The player's `directive` outranks every mood's `when`: pick the mood that serves it best." : ''),
        criteria,
      },
    };
    const { answers, ms } = await this.#request('sentiment', this.#state(sit), questions);
    const a = answers.sentiment;
    const choice = ids.includes(a?.choice) ? a.choice : ids.includes(memory.sentiment.id) ? memory.sentiment.id : defaultMood(ids);
    setSentiment(memory, { id: choice }, world.steps + 1);
    return { choice, probabilities: a?.probabilities ?? null, ms };
  }

  // next_move for one approach. speculative: asked once per tactic on a decision tick, so it keeps
  // only the safety line, the tactic's own hint and the mood's priority (the generic list lives in next_move).
  #moveQuestion(approachId, sit, profile, speculative, skillLine = false, targetOverride = null) {
    const world = this.#world;
    const memory = this.#memory;
    const cells = memory.recent.cells;
    // engage closes in on purpose: its moves are judged without the mood's minimum gap.
    const gap = approachId === 'engage' ? 1 : profile.min_gap;
    const cornered = Boolean(this.#cornerOpt()); // cornerMode: gating relaxed, urgent text (also while a kept route is walked)
    const parts = describeMoveParts(world, approachId, {
      minGap: gap,
      goal: speculative ? targetOverride?.cell ?? null : this.#goal(),
      targetOverride,
      avoid: this.#zone,
      exclude: this.#exclude,
      remembered: this.#remembered,
      prev: cells.length > 1 && !cornered ? cells.at(-2) : null, // cornered: undoing the last move is no sin
      backAndForth: cornered ? 0 : memory.recent.back_and_forth,
      stunned: this.#stunnedIds(),
      multiHold: this.#holdOn === 'multi',
      ...(cornered ? { noGapWarn: true, breakout: this.#cornerOpt().breakout ?? null } : {}),
    });
    // Option order is shuffled every tick because Jev leans toward the first option.
    // Speculative: the facts that do not depend on the tactic are sent once, in `surroundings.moves`
    // (same for every move_if_<tactic>); each option keeps only its progress toward this tactic's target.
    const dirs = shuffle(world.availableMoves());
    // A live directive parks the approach: on an ordinary tick the moves lose their "progress toward the target" part.
    const live = this.directive;
    const parked = Boolean(live) && !speculative && !isTactic(approachId);
    const whole = (p) => p.whole ?? [p.shared, parked ? null : p.target].filter(Boolean).join(' ') ?? '';
    // `stay` is the same under every tactic, so its whole fact goes to the shared facts and the option is short.
    const specOption = (d) => (d === STAY ? (parts[d].holding ? parts[d].whole : 'Stand still.') : parts[d].whole ?? parts[d].target);
    const options = Object.fromEntries(dirs.map((d) => [d, speculative ? specOption(d) : whole(parts[d])]));
    const shared = Object.fromEntries(world.availableMoves().filter((d) => d === STAY || !parts[d].whole).map((d) => [d, parts[d].shared ?? parts[d].whole]));
    const question = speculative
      ? `Step for the "${approachId}" tactic? Options: progress to its target; other facts per move: \`surroundings.moves\`.`
      : live
        ? 'Which way should the explorer step next to follow the player\'s `directive`? Judge each move from its description, `surroundings` and `recent`.'
        : `Which way should the explorer step next? It feels ${memory.sentiment.id} (\`self.mind\`); judge each move from its description, \`surroundings\` and \`recent\`.`;
    const portalSeen = sit.surroundings.exit !== 'not seen yet';
    const portalLine = live
      ? 'Stepping onto the portal wins the game; follow the player directive while it is active.'
      : speculative
        ? 'Step onto the portal to win; else clear or slip past enemies toward it.'
        : 'Take a move onto the portal to win; otherwise clear or slip past obstacles and advance toward it along the known path.';
    const engaging = approachId === 'engage';
    const hint = cornered && approachId === 'slip_past'
      ? 'Follow the route past it; a claw may land, but getting out matters more.'
      : cornered && !TACTIC_MOVE_HINT[approachId] ? 'Get out of the pocket.' : TACTIC_MOVE_HINT[approachId] ?? 'Avoid known dead ends where you can be cornered; keep the distance growing.';
    const safety = sit.threats.visible.length
      ? [
          approachId === 'engage'
            ? `Never step onto an enemy. ${hint}`
            : cornered
            ? `Never step onto an enemy. ${hint}`
            : speculative
            ? `Never step into an enemy; keep ${gap}+ steps from it. ${hint}`
            : `Never step into an enemy; avoid moves marked "below your minimum gap" (under ${gap} steps). ${hint}`,
        ]
      : [];
    // The one-per-tactic questions decide the move on a decision tick, so they keep the mood's rule (shortened).
    const dirLine = live ? [directiveLine(live.text)] : [];
    const cornerLines = cornered ? this.#cornerMoveLines(approachId, speculative) : [];
    const priorities = live
      ? speculative
        ? [...dirLine, ...(portalSeen ? [portalLine] : []), ...safety]
        : [
          ...dirLine,
          ...(portalSeen ? [portalLine] : []),
          ...safety,
          ...(sit.threats.remembered.length ? ['Do not head toward where an enemy was last seen (`threats.remembered`) unless the directive needs it.'] : []),
        ]
      : speculative
      ? [...cornerLines, ...(portalSeen ? [portalLine] : []), ...safety, ...(engaging || cornered ? [] : [profile.move_priority])]
      : engaging ? [
          // engage: the hint in `safety` is the whole plan. The mood's lines ("moving toward one is fine"), "stay makes no
          // progress" and "reveal new cells" would talk the explorer off the holding cell (P7a).
          ...cornerLines,
          ...(portalSeen ? [portalLine] : []),
          ...safety,
          ...(sit.threats.remembered.length ? ['Do not head toward where an enemy was last seen (`threats.remembered`) unless the approach needs it.'] : []),
          ...(skillLine ? [`Skills: ${profile.skill_priority}`] : []),
        ]
      : [
          ...cornerLines,
          ...(portalSeen ? [portalLine] : []),
          ...safety,
          ...(sit.threats.remembered.length ? ['Do not head toward where an enemy was last seen (`threats.remembered`) unless the approach needs it.'] : []),
          ...(this.#world.health < this.#world.maxHealth && this.#world.seenHearts().length ? ['You are hurt: a seen heart restores a life, so a detour for it is worth it unless an enemy is near.'] : []),
          ...(nearbyPiles(this.#world, COIN_NEAR).length ? ['Coins are the score: a step toward a seen pile beats revealing new cells unless an enemy is near.'] : []),
          ...(cornered ? [] : [profile.priority]),
          ...(skillLine ? [`Skills: ${profile.skill_priority}`] : []),
          'Stay makes no progress and lets enemies close in: only when every step is worse.',
          'Follow the approach (`plan.approach.current`): prefer moves closer to its target.',
          'Prefer moves revealing many new cells or onto never-visited cells.',
          cornered
            ? 'Do not wait or shuffle inside the pocket: any step that gets you out beats staying.'
            : 'Avoid backtracking: no known dead end with nothing left to explore, and do not undo the previous move unless every other way is explored (`recent`).',
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
    // Portal discovery commits the destination; ordinary reviews only compare exploration approaches.
    const alternatives = availableApproaches(world).filter((id) => id !== approachId && id !== 'go_to_exit');
    if (alternatives.length) {
      questions.next_approach = this.#nextApproachQuestion(
        alternatives,
        'If `plan.approach.current` were dropped, which approach should the explorer try next? Avoid approaches in `plan.tried` that already failed, use `surroundings.unexplored_by_direction`, and steer clear of where enemies were just seen (`threats.remembered`).',
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
    interruptApproach(memory, approachOf(id), trigger === 'encounter' ? 'met an enemy' : `encounter: ${trigger.replace(/_/g, ' ')}`, prev);
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
      this.#capFired = new Set();
      countEncounter(memory, 'count', at);
    }

    if (visible.length) info.unseen = 0;
    else info.unseen += 1;
    if (visible.some((v) => v.mode === 'chase')) this.#cs = seeChase(this.#cs);

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
      policy = { from, to: a.id, reason: `no enemy in sight for ${info.unseen} tick${info.unseen === 1 ? '' : 's'}` };
      trigger = 'chase_over';
      { // evaded: it had a chasing sighting and ended with no hit and no dispel
        const evaded = this.#cs.counts.evaded;
        this.#cs = closeEncounter(this.#cs, world.health, world.maxHealth);
        if (this.#cs.counts.evaded > evaded) { this.#csWhy.push('evaded'); this.#syncConfidence(); }
      }
      info.active = false;
      this.#exclude = null;
      this.#capFired = new Set();
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
    if (this.#corner) return; // cornered: the pocket cells ARE the way out; do not rule the breakout route out
    const cells = this.#memory.recent.cells.slice(-2).map(key);
    const goal = this.#goal();
    this.#exclude = new Set([...(this.#exclude ?? []), ...cells, ...(goal ? [key(goal)] : [])]);
    this.#tacticGoal = null;
  }

  // ---- cornerMode (PLAN-corner.md). All of it is inert with CORNER_MODE 'off'.
  // Once per tick, from the cornerFacts of encounter.js; also keeps/drops the committed breakout route.
  #watchCorner(sit) {
    this.#corner = null;
    if (CORNER_MODE === 'off' || !sit.threats.visible.length) { this.#route = null; return; }
    const world = this.#world;
    const bounced = this.#memory.recent.back_and_forth >= 2;
    this.#corner = cornerFacts(world, threatsOf(world), { bounced }) ?? null;
    const r = this.#route;
    if (r && (world.steps > r.until || sameCell(r.cell, world.pos) || !knownDistances(world, world.pos).has(r.cell))) this.#route = null;
  }

  // The `cornered` option for tacticFeasibility / approachTarget: the facts with the breakout replaced by the committed
  // route (route, full) so the goal cannot flip tick to tick. null when not cornered and no route is being kept.
  #cornerOpt() {
    const c = this.#corner, r = this.#route;
    const mode = CORNER_MODE;
    if (mode === 'off' || this.directive) return null;
    const keep = r && (mode === 'route' || mode === 'full');
    if (!c && !keep) return null;
    if (keep) {
      const d = knownDistances(this.#world, this.#world.pos).get(r.cell);
      if (d !== undefined) return { ...(c ?? {}), breakout: { cell: r.cell, steps: d, why: r.why } };
    }
    const b = c.breakout;
    return { ...c, breakout: b?.cells?.length ? { cell: b.cells.at(-1), steps: b.steps, why: b.why } : null };
  }

  // route, full: commit to the breakout route's end while it is being walked (not for ascii / urgent: those let Jev pick).
  #keepRouteGoal() {
    if (CORNER_MODE !== 'route' && CORNER_MODE !== 'full') return;
    const b = this.#corner?.breakout;
    if (b && !this.#route && b.cells?.length) {
      const cell = [...b.cells.at(-1)];
      this.#route = { cell, until: this.#world.steps + b.steps + 1, why: b.why };
    }
    if (this.#memory.approach.id === 'slip_past' && this.#route) this.#tacticGoal = { id: 'slip_past', cell: [...this.#route.cell] };
  }

  #cornerTacticLine() {
    const c = this.#corner;
    if (!c || this.directive) return [];
    return [`${c.why ?? 'You are cornered.'} Backing deeper into the pocket will not help: slip past it or fight through (engage while the sword is ready).`];
  }

  #cornerMoveLines(approachId, speculative) {
    const c = this.#cornerOpt();
    if (!c) return [];
    const out = [];
    if (this.#corner) {
      const walls = c.walls ?? 0;
      out.push(speculative
        ? 'Cornered: do not shuffle; get out now (slip past or fight through).'
        : `You are cornered (${walls} wall${walls === 1 ? '' : 's'}). Do not shuffle in the pocket: get out now, turning round and slipping past is fine, so is fighting through.`);
    }
    if ((CORNER_MODE === 'route' || CORNER_MODE === 'full') && c.breakout && (!speculative || approachId === 'slip_past')) {
      out.push(c.breakout.why); // "Break out: 4 steps east,east,north,north; closest approach ..."
    }
    if ((CORNER_MODE === 'ascii' || CORNER_MODE === 'full') && !speculative && this.#corner?.diagram?.length) out.push('Map of the area: `surroundings.local_map` (E you, G enemy, # wall, . floor, ? unknown).');
    return out;
  }

  // run_away keeps its escape spot every tick (not only at decisions) so it cannot flip between two
  // cells as the adversary moves: approachTarget keeps the goal until it is reached or unsafe.
  #keepEscapeGoal(profile) {
    if (this.#memory.approach.id !== 'run_away') return;
    const t = approachTarget(this.#world, 'run_away', { minGap: profile.min_gap, goal: this.#goal(), exclude: this.#exclude, remembered: this.#remembered });
    this.#tacticGoal = t ? { id: 'run_away', cell: t.cell } : null;
  }

  #lethalWalkIn(dir, skillKey) {
    const world = this.#world;
    if (dir === STAY || skillKey !== 'none' || world.graceLeft > 0) return false;
    const dest = nextCell(world.pos, dir);
    return world.visibleAdversaries().some((th) =>
      th.mode === 'chase' && !this.#stunnedIds().has(th.id) && !sameCell(dest, th.pos) &&
      threatDistance(th, world.pos) > 1 && threatDistance(th, dest) <= 1 &&
      world.health <= (th.clawDamage ?? 1));
  }

  // The kept goal of the current tactic or ordinary approach (null when it belongs to another plan).
  #goal() {
    const memory = this.#memory;
    const g = isTactic(memory.approach.id) ? this.#tacticGoal : this.#approachGoal;
    return g && g.id === memory.approach.id ? g.cell : null;
  }

  #tacticFailing(profile, sit) {
    const world = this.#world;
    const memory = this.#memory;
    const id = memory.approach.id;
    const target = approachTarget(world, id, { minGap: profile.min_gap, goal: this.#goal(), exclude: this.#exclude, remembered: this.#remembered, stunned: this.#stunnedIds(), cornered: Boolean(this.#cornerOpt()) });
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

  // The portal is known: record it once and commit the destination immediately.
  // An encounter keeps its tactic, with the portal as the plan to resume; directives stay active.
  #spotExit(step) {
    const world = this.#world;
    const memory = this.#memory;
    if (world.won || !exitSeen(world) || memory.landmarks.some((l) => l.kind === 'exit')) return;
    const at = Math.max(step, 1);
    addEvent(memory, at, 'Saw the portal: reach and step through it to win.');
    addLandmark(memory, { kind: 'exit', cell: world.seenTreasure(), step, note: 'The portal: stepping on it is the only way to win.' });
    this.#encounter.pending = 'exit';
    this.#leaveDue = false;
    this.#leave(1, at);
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
        `Advance to the known portal now to win, clearing or slipping past obstacles on the way? ${leaveFacts(this.#world, sit)}`,
      criteria: {
        true: 'Advance to the portal: stepping through it is the only win.',
        false: 'Recover or reposition briefly, then resume advancing to the portal.',
      },
    };
  }

  // Commit go_to_exit as the approach (mid-encounter, the one to resume). Returns the switch.
  #leave(p, step) {
    const memory = this.#memory;
    const a = memory.approach;
    const at = Math.max(step, 1);
    const reason = 'Portal known: committed to reaching it and stepping through to win.';
    addEvent(memory, at, 'Destination: reach the portal and step through to win.');
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

// Central config hook (src/config/runtime.js): the constants above are `let` so a changed value is seen by every importer.
export function configureExplorerBrain(o) {
  if (o.cornerMode !== undefined) CORNER_MODE = o.cornerMode;
  if (o.brainReviewEvery !== undefined) REVIEW_EVERY = o.brainReviewEvery;
  if (o.brainApproachFailing !== undefined) APPROACH_FAILING = o.brainApproachFailing;
  if (o.brainRedecideCooldown !== undefined) REDECIDE_COOLDOWN = o.brainRedecideCooldown;
  if (o.brainRememberSteps !== undefined) REMEMBER_STEPS = o.brainRememberSteps;
  if (o.brainSkillNear !== undefined) SKILL_NEAR = o.brainSkillNear;
  if (o.brainSkillRememberSteps !== undefined) SKILL_REMEMBER_STEPS = o.brainSkillRememberSteps;
  if (o.brainThreatSteps !== undefined) THREAT_STEPS = o.brainThreatSteps;
  if (o.brainGhostsCanAttack !== undefined) GHOSTS_CAN_ATTACK = o.brainGhostsCanAttack;
  if (o.brainHoldMax !== undefined) HOLD_MAX = o.brainHoldMax;
  if (o.brainHoldAdjacentMax !== undefined) HOLD_ADJACENT_MAX = o.brainHoldAdjacentMax;
  if (o.brainPingpongFails !== undefined) PINGPONG_FAILS = o.brainPingpongFails;
  if (o.brainHealNear !== undefined) HEAL_NEAR = o.brainHealNear;
  if (o.brainCoinNear !== undefined) COIN_NEAR = o.brainCoinNear;
  if (o.brainCoinEvery !== undefined) COIN_EVERY = o.brainCoinEvery;
  if (o.brainCoinSwitch !== undefined) COIN_SWITCH = o.brainCoinSwitch;
  if (o.brainDirectiveDone !== undefined) DIRECTIVE_DONE = o.brainDirectiveDone;
  if (o.brainDirectiveAskEvery !== undefined) DIRECTIVE_ASK_EVERY = o.brainDirectiveAskEvery;
  if (o.brainLeaveNow !== undefined) LEAVE_NOW = o.brainLeaveNow;
  for (const id of Object.keys(SENTIMENTS)) {
    if (o[`mood_${id}_minGap`] !== undefined) SENTIMENTS[id].min_gap = o[`mood_${id}_minGap`];
    if (o[`mood_${id}_endTicks`] !== undefined) SENTIMENTS[id].end_ticks = o[`mood_${id}_endTicks`];
  }
}
// The values in force, keyed like the registry (the config check compares them with the registry defaults).
export const explorerBrainSnapshot = () => ({ brainReviewEvery: REVIEW_EVERY, brainApproachFailing: APPROACH_FAILING, brainRedecideCooldown: REDECIDE_COOLDOWN, brainRememberSteps: REMEMBER_STEPS, brainSkillNear: SKILL_NEAR, brainSkillRememberSteps: SKILL_REMEMBER_STEPS, brainThreatSteps: THREAT_STEPS, brainGhostsCanAttack: GHOSTS_CAN_ATTACK, cornerMode: CORNER_MODE, brainHoldMax: HOLD_MAX, brainHoldAdjacentMax: HOLD_ADJACENT_MAX, brainPingpongFails: PINGPONG_FAILS, brainHealNear: HEAL_NEAR, brainCoinNear: COIN_NEAR, brainCoinEvery: COIN_EVERY, brainCoinSwitch: COIN_SWITCH, brainDirectiveDone: DIRECTIVE_DONE, brainDirectiveAskEvery: DIRECTIVE_ASK_EVERY, brainLeaveNow: LEAVE_NOW, ...Object.fromEntries(Object.entries(SENTIMENTS).flatMap(([id, m]) => [[`mood_${id}_minGap`, m.min_gap], [`mood_${id}_endTicks`, m.end_ticks]])) });

// ---- Prompt wording from the central config (src/config/runtime.js). A key set to null (or absent) means the built-in text,
// which is copied here at load, before any configure call. Static text only: nothing in it can pull in game data.
const PROMPT_SLOTS = {};
for (const id of Object.keys(SENTIMENTS)) {
  for (const [field, name] of [['when', 'when'], ['note', 'note'], ['priority', 'priority'], ['move_priority', 'movePriority'], ['skill_priority', 'skillPriority']]) {
    PROMPT_SLOTS[`mt_${id}_${name}`] = { get: () => SENTIMENTS[id][field], set: (v) => { SENTIMENTS[id][field] = v; } };
  }
}
for (const id of Object.keys(MOOD_GLOSS)) PROMPT_SLOTS[`moodGloss_${id}`] = { get: () => MOOD_GLOSS[id], set: (v) => { MOOD_GLOSS[id] = v; } };
for (const id of Object.keys(TRIGGER_TEXT)) PROMPT_SLOTS[`trigger_${id}`] = { get: () => TRIGGER_TEXT[id], set: (v) => { TRIGGER_TEXT[id] = v; } };
for (const id of Object.keys(TACTIC_MOVE_HINT)) PROMPT_SLOTS[`tacticHint_${id}`] = { get: () => TACTIC_MOVE_HINT[id], set: (v) => { TACTIC_MOVE_HINT[id] = v; } };
PROMPT_SLOTS.capsSentence = { get: () => CAPS_SENTENCE, set: (v) => { CAPS_SENTENCE = v; } };
const BUILTIN_PROMPTS = Object.fromEntries(Object.entries(PROMPT_SLOTS).map(([k, s]) => [k, s.get()]));
export function configureExplorerPrompts(o) {
  for (const [k, slot] of Object.entries(PROMPT_SLOTS)) slot.set(typeof o[k] === 'string' ? o[k] : BUILTIN_PROMPTS[k]);
}
export const explorerPromptDefaults = () => ({ ...BUILTIN_PROMPTS });
export const explorerPromptSnapshot = () => Object.fromEntries(Object.entries(PROMPT_SLOTS).map(([k, s]) => [k, s.get()]));
