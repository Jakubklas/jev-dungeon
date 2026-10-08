// The `skill` Choice question and the confidence floor. `none` is listed first and never shuffled
// (Jev leans toward the first option: for ghosts that bias is wanted; the explorer's neutral wording
// and its mood's skill line decide when it strikes).

export let SKILL_MIN = 0.5; // a skill is used only when its probability reaches this (skills.minProbability)
export function configureQuestion(o) { if (typeof o.skillMin === 'number') SKILL_MIN = o.skillMin; }

// options: { key: { fact } } from SkillSet.options. null when empty (nothing is asked).
// neutral: the explorer's wording, which states the choice without steering toward `none` (its mood's
// priority line says when to strike). Ghosts keep the original wording (their requests stay byte-identical).
const LEAD = {
  default: { question: 'Besides the move, use at most one skill this step. Choose `none` unless a skill clearly helps right now.', none: 'Use no skill this step (the usual choice).' },
  neutral: { question: 'Use at most one skill this step, besides the move.', none: 'No skill this step.' },
};
export function skillQuestion(options, priorityLine = '', { neutral = false } = {}) {
  const keys = Object.keys(options ?? {});
  if (!keys.length) return null;
  const lead = neutral ? LEAD.neutral : LEAD.default;
  return {
    type: 'choice',
    instructions: {
      question: `${lead.question}${priorityLine ? ` ${priorityLine}` : ''}`,
    },
    criteria: {
      none: lead.none,
      ...Object.fromEntries(keys.map((k) => [k, options[k].fact])),
    },
  };
}

// answer: { choice, probabilities }. Returns the chosen option key, or 'none' when the choice is not
// an option or its probability is below SKILL_MIN (or unknown).
export function pickSkill(answer, options) {
  const choice = answer?.choice;
  if (typeof choice !== 'string' || choice === 'none' || !Object.hasOwn(options ?? {}, choice)) return 'none';
  const p = answer.probabilities?.[choice];
  return typeof p === 'number' && p >= SKILL_MIN ? choice : 'none';
}
