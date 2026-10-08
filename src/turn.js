// One world tick: the explorer moves (Jev decides), then the adversaries move (each brain-on
// adversary's Jev brain decides, in parallel). A Run owns one game plus its explorer memory and
// builds the browser view. The server uses only this module.
import { Game, generateDungeon } from './dungeon.js';
import { spawnCoins } from './coins.js';
import { spawnHearts } from './hearts.js';
import { brainView, graceLeft, seesExplorer, spawnAdversaries, stepAdversaries } from './characters/adversary/adversary.js';
import { saveMemories } from './characters/adversary/memory.js';
import { buildArena, explorerSkillSetOf } from './testbed.js';
import { saveMemory } from './characters/explorer/memory.js';
import { ExplorerBrain } from './characters/explorer/brain.js';
import { KnownWorld } from './characters/explorer/known-world.js';

const DIR = new URL('../', import.meta.url); // dungeon-game/ (adversaries.json lives here)

// Player directive text (POST /api/inject): whitespace and newlines become single spaces, control,
// bidi and zero-width characters go, then trim. Returns '' for nothing left (= clear the directive).
export function sanitiseDirective(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// One game in progress. `opts`: `ask` / `decide` replace the explorer's / adversaries' Jev call
// (the checks pass stubs), `memoryDir` is where the explorer's memory files go, `dir` where
// adversaries.json goes. Without them a Run talks to the real Jev and writes next to the server.
// `confidence` (default none) is an optional arm object { start, wPerExtra, weights, model } for the checks and measurements; the explorer's confidence caps its moods always (PLAN-moods).
export class Run {
  #dir;
  #memoryDir;
  #decide; // null = the real Jev
  #stepping = false; // a playTurn is in flight: a directive sent now waits for the next step
  #pending = null; // { text, steps } to set, or { clear: true }, applied at the start of the next playTurn
  #lastInjectAt = -Infinity; // wall-clock ms of the last accepted directive (the cooldown)

  constructor(dungeon, adversaries, { ask = null, decide = null, dir = null, memoryDir = null, skills = 'explorer', hold = 'multi', confidence = false } = {}) {
    this.game = new Game(dungeon);
    this.game.adversaries = adversaries;
    this.#decide = decide;
    this.explorer = new ExplorerBrain(new KnownWorld(this.game), { ask, memoryDir, skills, hold, confidence });
    this.#dir = dir ?? DIR;
    this.#memoryDir = memoryDir ?? DIR;
  }

  get memory() {
    return this.explorer.memory;
  }

  // Writes the opening memory files (memory.json/md, adversaries.json) so a new game does not leave the
  // previous game's files lying around until its first paid step. The server calls this; the checks
  // do not (unless they pass temp dirs).
  async persist() {
    await saveMemory(this.explorer.memory, this.#memoryDir);
    await saveMemories(this.game.adversaries.map((a) => a.memory), this.game.steps, this.#dir);
  }

  // Thin passthroughs to the explorer's directive (PLAN-inject). The directive is the player's own text.
  get directive() {
    return this.explorer.directive ?? null;
  }

  inject(text, { steps } = {}) {
    return this.explorer.setDirective(text, { steps });
  }

  clearDirective(reason = 'cleared by player') {
    return this.explorer.clearDirective(reason);
  }

  // POST /api/inject policy, kept here so it is testable without HTTP. Returns { status, body }:
  // 200 { directive, queued }, 400 bad / too long text, 409 game over, 429 cooldown with retry_in_ms.
  // Empty text clears (no cooldown). A step in flight queues the change for the start of the next step,
  // so it never races takeTurn. `now` is injectable for checks.
  submitDirective(text, { maxChars = 140, steps = 20, cooldownMs = 10_000, now = Date.now() } = {}) {
    if (this.game.won || this.game.lost) return { status: 409, body: { error: `The game is already ${this.game.won ? 'won' : 'lost'}.` } };
    if (typeof text !== 'string') return { status: 400, body: { error: 'text must be a string.' } };
    const clean = sanitiseDirective(text);
    if (clean === '') {
      if (this.#stepping) this.#pending = { clear: true };
      else { this.#pending = null; this.clearDirective('cleared by player'); }
      return { status: 200, body: { directive: this.#stepping ? this.directive : null, queued: this.#stepping } };
    }
    if (clean.length > maxChars) return { status: 400, body: { error: `Directive is too long: ${clean.length} characters, at most ${maxChars}.`, max_chars: maxChars } };
    const wait = this.#lastInjectAt + cooldownMs - now;
    if (wait > 0) return { status: 429, body: { error: 'Wait before sending another directive.', retry_in_ms: Math.ceil(wait) } };
    this.#lastInjectAt = now;
    if (this.#stepping) {
      this.#pending = { text: clean, steps };
      return { status: 200, body: { directive: { text: clean, from_step: null, until_step: null, steps_left: steps }, queued: true } };
    }
    this.#pending = null;
    this.inject(clean, { steps });
    return { status: 200, body: { directive: this.directive, queued: false } };
  }

  #applyPending() {
    const p = this.#pending;
    this.#pending = null;
    if (!p) return;
    if (p.clear) this.clearDirective('cleared by player');
    else this.inject(p.text, { steps: p.steps });
  }

  async playTurn() {
    this.#stepping = true;
    try {
      this.#applyPending();
      return await this.#playTurn();
    } finally {
      this.#stepping = false;
    }
  }

  async #playTurn() {
    const { game } = this;
    const wasLost = game.lost;
    game.clearTickState(); // strikes are per tick; a lapsed block stance goes
    const coinsBefore = game.coins;
    const healthBefore = game.health;
    const explorer = await this.explorer.takeTurn();
    // The explorer's skill events: the brain's own list when it hands one back, else the strike flash
    // read from game.strikes (struck / dispelled need the brain's list).
    const skillEvents = explorer.skill_events ?? game.strikes.filter((s) => s.by === 'explorer').map((s) => ({ id: s.by, type: 'strike', cells: s.cells, result: s.result }));
    // stepAdversaries first bumps an adversary the explorer stepped onto (knockback only), and does
    // nothing once the game is won or lost.
    const { events: adversaryEvents, turns } = await stepAdversaries(game, { decide: this.#decide });
    const coinEvents = game.coins > coinsBefore ? [{ id: 'explorer', type: 'coin', at: [...game.pos], gained: game.coins - coinsBefore, total: game.coins }] : [];
    const heartEvents = game.health > healthBefore ? [{ id: 'explorer', type: 'heart', at: [...game.pos], health: game.health }] : [];
    const events = [...skillEvents, ...coinEvents, ...heartEvents, ...adversaryEvents];
    await saveMemories(game.adversaries.map((a) => a.memory), game.steps, this.#dir);
    const hit = events.find((e) => e.type === 'hit');
    if (game.lost && !wasLost) await this.explorer.noteCaught(game.caughtBy);
    else if (hit) await this.explorer.noteHit(hit.id);
    // The explorer's own shield stopped a claw (the confidence model's +3). Its own cell, its own shield: fog-safe.
    if (!(game.lost && !wasLost)) for (const e of events) if (e.type === 'blocked') await this.explorer.noteBlocked();
    return { ...explorer, directive: this.directive, events, lost: game.lost, caughtBy: game.caughtBy, adversaryTurns: turns };
  }

  view() {
    const { game } = this;
    return {
      ...game.publicView(),
      adversaries: game.adversaries.map((a) => ({
        id: a.id, pos: [...a.pos], mode: a.mode, visible: seesExplorer(game, a), brain: brainView(a), character: a.character, // character, facing: Reveal-only display; hp is drawn over ghosts in sight (the explorer reads the same bar)
        facing: a.facing, hp: a.hp, max_hp: a.maxHp,
      })),
      block: game.block, // the explorer's shield stance: null | { effectiveness, until_step } (its own state)
      grace_ticks: graceLeft(game),
      invulnerable: graceLeft(game) > 0,
      over: game.won || game.lost,
      directive: this.directive, // the live player directive { text, from_step, until_step, steps_left } or null
      testbed: !!game.dungeon.testbed,
      heart_cells: game.heartPiles.map((c) => [...c]), // floating hearts (restore a life)
    };
  }
}

export function newGame(seed, opts = {}) {
  const base = generateDungeon(seed ?? undefined);
  const withCoins = { ...base, coins: spawnCoins(base) }; // own PRNG stream: the layout and spawns never change
  const dungeon = { ...withCoins, hearts: spawnHearts(withCoins) }; // rare hearts, own stream too
  return new Run(dungeon, spawnAdversaries(dungeon), opts);
}

// A small configured arena (src/testbed.js) instead of a generated dungeon. Throws TestbedError
// on a bad config. Costs no Jev calls.
export function newTestGame(config, opts = {}) {
  const { dungeon, adversaries, config: cfg } = buildArena(config);
  return new Run(dungeon, adversaries, { skills: explorerSkillSetOf(cfg), ...opts });
}
