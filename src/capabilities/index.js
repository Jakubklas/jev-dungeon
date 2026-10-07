// Capability registry (P3 scaffold; nothing is registered yet, nothing is wired into a brain).
// A capability is an optional action beside the move: sprint, attack, pick_up. One spec, shared by
// the explorer and the adversaries:
//   { id, who: ['explorer'|'adversary'], text, feasible(view, self) -> null | { fact, target? },
//     apply(game, actor, target) }
// `text` names the capability in general; `feasible` returns a one-sentence `fact` about this
// step (or null: it never reaches Jev). `apply` runs the world rule, which lives in Game.
//
// How a brain wires it (later):
//   1. options = feasibleOptions(who, view, self), where `view` is the KnownWorld (explorer) or the
//      adversary view, so fog of war holds.
//   2. question = actionQuestion(options, contextLine). Ask it in the SAME request as the move,
//      only when it is non-null (an empty options map costs nothing).
//   3. After the move is applied, if the answer is not `none`, call CAPABILITIES[answer].apply(
//      game, actor, target), with target taken from the feasible() result.
// Pure: no Game import, no randomness (a capability needing chance uses the game's seeded RNG).

export const CAPABILITIES = {};

const WHO = ['explorer', 'adversary'];
export const NONE_OPTION = 'Do nothing special this step';

// Validates a spec and returns it frozen. Throws TypeError on a bad one.
export function defineCapability(spec) {
  const bad = (msg) => { throw new TypeError(`capability ${spec?.id ?? '?'}: ${msg}`); };
  if (!spec || typeof spec !== 'object') bad('spec must be an object');
  if (typeof spec.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(spec.id)) bad('id must be snake_case');
  if (spec.id === 'none') bad("id 'none' is reserved");
  if (!Array.isArray(spec.who) || !spec.who.length || !spec.who.every((w) => WHO.includes(w)) || new Set(spec.who).size !== spec.who.length) {
    bad(`who must be a non-empty list of ${WHO.join(' | ')}`);
  }
  if (typeof spec.text !== 'string' || !spec.text.trim()) bad('text must be a non-empty string');
  if (typeof spec.feasible !== 'function') bad('feasible must be a function');
  if (typeof spec.apply !== 'function') bad('apply must be a function');
  return Object.freeze({ ...spec, who: Object.freeze([...spec.who]) });
}

// { id: fact } for every capability of `who` that is feasible now, sorted by id so the order never
// depends on registration order. `registry` is a parameter so checks can pass their own.
export function feasibleOptions(who, view, self, registry = CAPABILITIES) {
  const out = {};
  for (const id of Object.keys(registry).sort()) {
    const cap = registry[id];
    if (!cap.who.includes(who)) continue;
    const res = cap.feasible(view, self);
    if (res) out[id] = res.fact;
  }
  return out;
}

// The `action` Choice question, or null when nothing is feasible. Each criterion is the fact; the
// brain shuffles nothing here, so callers keep control of option order.
export function actionQuestion(options, contextLine = '') {
  const ids = Object.keys(options ?? {});
  if (!ids.length) return null;
  return {
    type: 'choice',
    instructions: {
      question: `${contextLine ? `${contextLine} ` : ''}Besides moving, should it use a special action this step? Choose \`none\` unless an option clearly helps.`,
    },
    criteria: { ...Object.fromEntries(ids.map((id) => [id, options[id]])), none: NONE_OPTION },
  };
}
