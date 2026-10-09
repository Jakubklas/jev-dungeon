// The real brains and adapter with a fetch stub. Never loads .env or calls a paid API.
import assert from 'node:assert/strict';
process.env.JEV_CONFIG = 'none';
const { askJev, configureJev, jevModel, validateDecisionCredentials } = await import('../src/jev.js');
const { newTestGame } = await import('../src/turn.js');
const originalKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;
const requests = [];
const response = (answers) => ({ ok: true, json: async () => ({ answers }) });
const stub = async (url, options) => {
  const body = JSON.parse(options.body);
  requests.push({ url, options, body });
  assert.equal(url, 'https://api.openai.com/v1/decisions');
  return response(body.questions.map((q) => q.type === 'predicate'
    ? { name: q.name, type: 'predicate', probability: 0.8 }
    : { name: q.name, type: 'choice', choice: q.choices[0].value, confidence: 0.9,
      probabilities: q.choices.map((c, i) => ({ value: c.value, probability: i ? 0.2 / (q.choices.length - 1) : 0.8 })) }));
};
try {
  configureJev({ decisionProvider: 'openai', jevHedgeCopies: 4, jevRetries: 4 });
  delete process.env.OPENAI_API_KEY;
  assert.throws(validateDecisionCredentials, /OPENAI_API_KEY/);
  process.env.OPENAI_API_KEY = 'stub-openai-key';
  assert.equal(jevModel(), 'gpt-6-luna');
  globalThis.fetch = stub;
  const state = { self: { pos: [2, 3] }, known: { safe: true } };
  const questions = {
    move: { type: 'choice', instructions: { question: 'Where next?', priorities: ['Stay safe', 'Find loot'] }, criteria: { right: { fact: 'Known floor' }, stay: 'Wait' } },
    review: { type: 'noul', instructions: 'Is this working?', criteria: { true: 'Making progress', false: 'Going backwards' } },
    tactic: { type: 'choice', instructions: 'Choose a tactic', criteria: { engage: 'Fight the lone weak enemy' } },
  };
  // Pre-serialized brain bodies are the evidence source, just as for Jev/Laya.
  const answers = await askJev({}, {}, JSON.stringify({ model: jevModel(), state, questions }));
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.options.headers.Authorization, 'Bearer stub-openai-key');
  assert.deepEqual(JSON.parse(request.body.input), state);
  assert.deepEqual(Object.keys(request.body).sort(), ['input', 'model', 'questions']);
  assert.deepEqual(JSON.parse(request.body.questions[0].instructions), questions.move.instructions);
  assert.deepEqual(request.body.questions[0].choices, [{ value: 'right', description: '{"fact":"Known floor"}' }, { value: 'stay', description: 'Wait' }]);
  assert.ok(request.body.questions[1].instructions.includes('Making progress'));
  assert.ok(request.body.questions[1].instructions.includes('Going backwards'));
  assert.deepEqual(answers, { tactic: { choice: 'engage', probabilities: { engage: 1 }, confidence: 1 },
    move: { choice: 'right', confidence: 0.9, probabilities: { right: 0.8, stay: 0.2 } }, review: { noul: 0.8 } });
  await askJev(state, { tactic: questions.tactic });
  assert.equal(requests.length, 1, 'a sole choice needs no paid request');
  requests.length = 0;
  const run = newTestGame({ size: '9x9', numAdversaries: 1, props: 'none', treasure: 'far', seed: 3 });
  for (let i = 0; i < 4; i++) await run.playTurn();
  assert.ok(requests.some((r) => r.body.questions.some((q) => q.name === 'sentiment')));
  assert.ok(requests.some((r) => JSON.parse(r.body.input).self?.id === 'a1'), 'adversary uses OpenAI too');
  assert.ok(requests.every((r) => r.body.model === 'gpt-6-luna'));
  assert.ok(run.explorer.lastRequests().every((r) => r.model === 'gpt-6-luna'));
  for (const bad of [[], [{ name: 'move', type: 'refusal' }], [{ name: 'move', type: 'choice', choice: 'hidden', confidence: 1, probabilities: [] }]]) {
    globalThis.fetch = async () => response(bad);
    await assert.rejects(askJev(state, { move: questions.move }), /OpenAI Decider/);
  }
  let count = 0;
  globalThis.fetch = async (url) => { count++; assert.equal(url, 'https://api.openai.com/v1/decisions'); return { ok: false, status: 429, text: async () => 'rate limited' }; };
  await assert.rejects(askJev(state, { move: questions.move }), /OpenAI Decisions API 429/);
  assert.equal(count, 1, 'no retries, hedging or provider fallback');
  console.log('OpenAI Decider checks passed: conversion, credentials, both brains, forced choices, failures and no paid calls.');
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
}
