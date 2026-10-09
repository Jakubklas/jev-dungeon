// OpenAI Decisions adapter. Only the evidence and questions supplied by the brains enter the API.
// Wire schema: https://developers.openai.com/api/docs/guides/decisions
const text = (value) => typeof value === 'string' ? value : JSON.stringify(value);
const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

export async function askOpenAIDecider(state, questions, { model, timeoutMs }) {
  const pending = [];
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const instructions = text(q.instructions);
    if (q.type === 'choice') {
      const choices = Object.entries(q.criteria ?? {}).map(([value, description]) => ({ value, description: text(description) }));
      // Decisions requires at least two choices. A sole legal option needs no paid request.
      if (choices.length === 1) {
        const choice = choices[0].value;
        answers[name] = { choice, probabilities: { [choice]: 1 }, confidence: 1 };
      } else if (choices.length >= 2 && choices.length <= 255) {
        pending.push({ name, type: 'choice', instructions, choices });
      } else throw new Error(`OpenAI Decider: invalid choice count for ${name}`);
    } else if (q.type === 'noul') {
      pending.push({ name, type: 'predicate', instructions: `${instructions}\nTrue/false criteria: ${text(q.criteria ?? {})}` });
    } else throw new Error(`OpenAI Decider: unsupported question type ${q.type}`);
  }
  if (!pending.length) return answers;
  const response = await fetch('https://api.openai.com/v1/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text(state), questions: pending }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`OpenAI Decisions API ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  if (!Array.isArray(data.answers)) throw new Error('OpenAI Decider: missing answers');
  for (const q of pending) {
    const matches = data.answers.filter((answer) => answer.name === q.name);
    if (matches.length !== 1) throw new Error(`OpenAI Decider: missing or duplicate answer for ${q.name}`);
    const a = matches[0];
    if (a.type === 'refusal') throw new Error(`OpenAI Decider refused question ${q.name}`);
    if (q.type === 'predicate' && a.type === 'predicate' && probability(a.probability)) {
      answers[q.name] = { noul: a.probability };
    } else if (q.type === 'choice' && a.type === 'choice' && q.choices.some((c) => c.value === a.choice) &&
      Array.isArray(a.probabilities) && a.probabilities.length === q.choices.length &&
      q.choices.every((c) => a.probabilities.filter((p) => p.value === c.value && probability(p.probability)).length === 1) && probability(a.confidence)) {
      answers[q.name] = { choice: a.choice, confidence: a.confidence, probabilities: Object.fromEntries(a.probabilities.map((p) => [p.value, p.probability])) };
    } else throw new Error(`OpenAI Decider: invalid answer for ${q.name}`);
  }
  return answers;
}
