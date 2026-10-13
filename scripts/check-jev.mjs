// Checks for the Jev client (src/jev.js) with a mocked fetch: 503 is retried, a fast answer sends one request (the hedge is
// staggered; the default is one copy), with hedgeCopies 2 a slow first copy gets a second copy after HEDGE_DELAY_MS that can win, a persistent failure still throws. Free.
process.env.JEV_API_KEY = 'test';
const { askJev, configureJev } = await import('../src/jev.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(`FAIL: ${m}`); } };
const real = globalThis.fetch;
const reply = (status, answers = { x: 1 }) => ({ status, ok: status < 300, json: async () => ({ answers }), text: async () => 'no healthy upstream' });
const sleep = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true }); });
const mock = (fn) => { const calls = []; globalThis.fetch = async (url, init) => { const n = calls.push(performance.now()); return fn(n, init); }; return calls; };

let calls = mock(async () => reply(200));
ok(JSON.stringify(await askJev({}, {})) === '{"x":1}' && calls.length === 1, `a fast answer sends one request (${calls.length})`);

calls = mock(async (n) => (n === 1 ? reply(503) : reply(200, { y: 2 })));
const a = await askJev({}, {});
ok(a.y === 2 && calls.length === 2, `503 is retried (${calls.length} requests)`);

// The default is one copy (no hedging): a slow answer is waited for, never doubled.
calls = mock(async (n) => { await sleep(1000); return reply(200, { n }); });
const dflt = await askJev({}, {});
ok(dflt.n === 1 && calls.length === 1, `by default a slow call stays one request (${calls.length})`);

// The hedge is a dev-only option: with jev.hedgeCopies 2 a slow first copy gets a second after HEDGE_DELAY_MS.
configureJev({ jevHedgeCopies: 2 });
calls = mock(async (n, init) => { if (n === 1) { await sleep(3000, init.signal); return reply(200, { slow: 1 }); } return reply(200, { fast: 1 }); });
const t0 = performance.now();
const b = await askJev({}, {});
const dt = performance.now() - t0;
ok(b.fast === 1 && calls.length === 2 && dt >= 700 && dt < 1500, `a slow first copy gets a second after ~800 ms and it wins (${Math.round(dt)} ms, ${calls.length} requests)`);

calls = mock(async () => reply(503));
let threw = false;
try { await askJev({}, {}); } catch (e) { threw = /503/.test(e.message); }
ok(threw, 'a persistent 503 still throws');
configureJev({ jevHedgeCopies: 1 });
globalThis.fetch = real;
console.log(fails ? `${fails} FAIL(S)` : 'check-jev: ok');
process.exit(fails ? 1 : 0);
