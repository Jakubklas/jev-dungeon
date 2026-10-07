// The fighting executor shared by the confidence scripts (measure-confidence C0, calibrate-confidence C4): a stub
// Jev `ask` for the REAL ExplorerBrain with a fixed mood, engage when offered else run_away, the first non-none
// skill key, moves read from the move facts like the check-dungeon 4f stub, plus a seeded walk-in probability p
// (`own` is the script's PRNG, never rng() of the game). Stubs never read text: nothing here sees self.confidence.
import { DIRS } from '../../src/dungeon.js';
import { man } from './duel-harness.mjs';

const answer = (c) => ({ choice: c, probabilities: { [c]: 1 }, confidence: 1 });

export function makeAsk(game, p, own, probe, MOOD = 'bold') {
  return async ({ questions, state }) => {
    probe.state = state;
    // C4 reads this: a strike or `engage` was offered on this request (the start of a fight).
    if ((questions.skill && Object.keys(questions.skill.criteria).some((k) => k !== 'none')) || (questions.tactic && 'engage' in questions.tactic.criteria)) probe.offered = true;
    const visible = state.threats?.visible?.length > 0;
    const out = {};
    // One walk-in draw per tick (a decision tick makes two requests).
    if (probe.drawnAt !== game.steps) { probe.drawnAt = game.steps; probe.walkIn = visible && own() < p; }
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === 'noul') { out[k] = { noul: k === 'leave_now' ? 0.1 : 0.9 }; continue; }
      const keys = Object.keys(q.criteria);
      if (k === 'sentiment') out[k] = answer(keys.includes(MOOD) ? MOOD : keys[0]);
      else if (k === 'tactic') out[k] = answer(keys.includes('engage') ? 'engage' : keys.includes('run_away') ? 'run_away' : keys[0]);
      else if (k === 'skill') out[k] = answer(keys.find((x) => x !== 'none') ?? 'none');
      else if (k === 'next_move' || k.startsWith('move_if_')) {
        const moves = keys.filter((d) => d !== 'stay');
        let pick = null;
        if (probe.walkIn) {
          const near = game.adversaries.reduce((b, a) => (!b || man(a.pos, game.pos) < man(b.pos, game.pos) ? a : b), null);
          const nx = (d) => [game.pos[0] + DIRS[d][0], game.pos[1] + DIRS[d][1]];
          if (near) pick = moves.filter((d) => man(nx(d), near.pos) >= 1).sort((a, b) => man(nx(a), near.pos) - man(nx(b), near.pos))[0] ?? null;
        }
        pick ??= moves.find((d) => /Reaches the target/.test(q.criteria[d])) ?? moves.find((d) => /Closer to the target/.test(q.criteria[d])) ?? null;
        out[k] = answer(pick ?? moves[0] ?? 'stay');
      } else out[k] = answer(keys[0]);
    }
    return out;
  };
}

