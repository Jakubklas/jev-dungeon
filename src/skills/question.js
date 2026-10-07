// The `skill` Choice question and the confidence floor. `none` is listed first and never shuffled
// (Jev leans toward the first option; here that bias is wanted: most steps need no skill).

export const SKILL_MIN = 0.5; // a skill is used only when its probability reaches this

// options: { key: { fact } } from SkillSet.options. null when empty (nothing is asked).
export function skillQuestion(options, priorityLine = '') {
  const keys = Object.keys(options ?? {});
  if (!keys.length) return null;
  return {
    type: 'choice',
    instructions: {
      question: `Besides the move, use at most one skill this step. Choose \`none\` unless a skill clearly helps right now.${priorityLine ? ` ${priorityLine}` : ''}`,
    },
    criteria: {
      none: 'Use no skill this step (the usual choice).',
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
