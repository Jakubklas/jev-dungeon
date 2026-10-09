// Transport and real-brain serialization checks. Fetch is stubbed: never calls either service.
import assert from 'node:assert/strict';
process.env.JEV_CONFIG = 'none';
const { configureJev, askJev, jevModel, validateDecisionCredentials } = await import('../src/jev.js');
const { parseConfig } = await import('../src/config/load.js');
const { newTestGame } = await import('../src/turn.js');
const originalKey = process.env.JEV_API_KEY;
const requests = [];
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  requests.push({ url, options, body });
  const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]) => {
    const first = Object.keys(q.criteria ?? {})[0];
    return [k, q.type === 'noul' ? { noul: 0.9 } : { choice: first, probabilities: { [first]: 1 }, confidence: 1 }];
  }));
  return { ok: true, status: 200, json: async () => ({ answers }) };
};
try {
  delete process.env.JEV_API_KEY;
  assert.throws(validateDecisionCredentials, /JEV_API_KEY/);
  configureJev({ decisionProvider: 'laya', jevHedgeCopies: 4, jevHedgeDelayMs: 1 });
  assert.equal(jevModel(), 'multilingual');
  validateDecisionCredentials();
  await askJev({ test: true }, {});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:8000/v1/systemone');
  assert.equal(requests[0].body.model, 'multilingual');
  assert.equal(requests[0].body.max_len, 8192);
  assert.equal(requests[0].body.head_max_len, 1024);
  assert.equal(requests[0].options.headers.Authorization, undefined);
  process.env.JEV_API_KEY = 'stub-secret';
  const run = newTestGame({ size: '9x9', numAdversaries: 1, props: 'none', treasure: 'far', seed: 3 });
  await run.playTurn();
  assert.ok(requests.length > 1);
  assert.ok(requests.every((r) => r.body.model === 'multilingual' && r.body.max_len === 8192 && r.body.head_max_len === 1024 && !r.options.headers.Authorization));
  assert.ok(run.explorer.lastRequests().every((r) => r.model === 'multilingual'));
  requests.length = 0;
  globalThis.fetch = async (url) => { requests.push(url); return { ok: false, status: 503, text: async () => 'unavailable' }; };
  await assert.rejects(askJev({}, {}), /local Laya API 503/);
  assert.deepEqual(requests, ['http://127.0.0.1:8000/v1/systemone']);
  assert.throws(() => configureJev({ layaEndpoint: 'https://remote.example/v1/systemone' }), /localhost/);
  assert.throws(() => configureJev({ layaEndpoint: 'http://user:password@localhost:8000/v1/systemone' }), /localhost/);
  const bad = parseConfig({ decision: { laya: { endpoint: 'http://evil.example/v1/systemone' } } });
  assert.ok(bad.warnings.length);
  requests.length = 0;
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ answers: {} }) }; };
  configureJev({ decisionProvider: 'jev', jevHedgeCopies: 1 });
  await askJev({}, {});
  assert.equal(requests[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer stub-secret');
  assert.equal(JSON.parse(requests[0].options.body).model, 'jev-latest');
  assert.equal(JSON.parse(requests[0].options.body).max_len, undefined);
  assert.equal(JSON.parse(requests[0].options.body).head_max_len, undefined);
  console.log('All decision provider checks passed.');
} finally {
  if (originalKey === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = originalKey;
}
