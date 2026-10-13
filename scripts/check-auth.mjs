// Checks for the hosted service's auth and plumbing (src/service/{auth,ratelimit,ids,log,http,settings-service}.js):
// cookies, host session, loopback and HOST_REMOTE, origin check, name sanitising, rate limits (fake clock), the settings
// service (put/get/revisions/validation, frozen rules snapshots) and the SSE helper against a real localhost server.
// Free, no Jev, no network beyond an ephemeral localhost port: node scripts/check-auth.mjs
import { installTripwire } from './lib/tripwire.mjs';
process.env.JEV_CONFIG = 'none';
installTripwire();

import http from 'node:http';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAuth, HOST_COOKIE, checkOrigin, clearCookie, isLoopback, newParticipantToken, parseCookies, participantCookieName, participantCookies, participantToken, safeEqual, sanitiseName, serializeCookie } from '../src/service/auth.js';
import { RateLimiter } from '../src/service/ratelimit.js';
import { isId, newId } from '../src/service/ids.js';
import { createLogger } from '../src/service/log.js';
import { HttpError, Router, openSse, readJson, send } from '../src/service/http.js';
import { FileStore } from '../src/service/store.js';
import { SettingsService, EDITABLE_KEYS } from '../src/service/settings-service.js';

let failures = 0;
const fail = (m) => { failures++; if (failures <= 30) console.error('FAIL:', m); };
const check = (ok, m) => ok || fail(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (headers = {}, addr = '127.0.0.1') => ({ headers, socket: { remoteAddress: addr } });

// ---- ids ----
{
  const a = newId('gm_');
  check(a.startsWith('gm_') && isId('gm_', a) && !isId('par_', a), 'gm_ id shape');
  check(newId('par_') !== newId('par_') && isId('par_', newParticipantToken()), 'par_ ids differ');
  try { newId('x_'); fail('unknown prefix'); } catch { /* expected */ }
}

// ---- cookies ----
{
  const c = serializeCookie('a', 'b c', { path: '/p', maxAgeS: 5 });
  check(/HttpOnly/.test(c) && /SameSite=Strict/.test(c) && /Path=\/p/.test(c) && /Max-Age=5/.test(c), 'cookie flags');
  check(parseCookies('x=1; a=b%20c; a=other').a === 'b c' && parseCookies('x=1').x === '1', 'parse (first wins, decode)');
  check(Object.keys(parseCookies(undefined)).length === 0, 'no header');
  check(/Max-Age=0/.test(clearCookie('a', '/')), 'clear cookie');
  const gid = newId('gm_');
  const tok = newParticipantToken();
  const lines = participantCookies(gid, tok, { pagePath: '/play' });
  check(lines.length === 2 && lines[0].includes(`Path=/v1/games/${gid}`) && lines[1].includes('Path=/play') && lines.every((l) => l.startsWith(`jd_par_${gid}=`) && /HttpOnly/.test(l) && /SameSite=Strict/.test(l)), 'participant cookies: api path and page path');
  check(participantCookieName(gid) === `jd_par_${gid}`, 'cookie name');
  check(participantToken(req({ cookie: `${participantCookieName(gid)}=${tok}` }), gid) === tok, 'participant token read');
  check(participantToken(req({ cookie: `${participantCookieName(gid)}=junk` }), gid) === null, 'malformed token ignored');
  check(participantToken(req({ cookie: `${participantCookieName('gm_other')}=${tok}` }), gid) === null, 'other game cookie ignored');
  check(safeEqual('abc', 'abc') && !safeEqual('abc', 'abd') && !safeEqual('abc', 'abcd') && !safeEqual('a', undefined), 'safeEqual');
}

// ---- loopback, host session ----
{
  check(isLoopback(req({}, '127.0.0.1')) && isLoopback(req({}, '::1')) && isLoopback(req({}, '::ffff:127.0.0.1')), 'loopback addresses');
  check(!isLoopback(req({}, '192.168.1.5')) && !isLoopback(req({}, '::ffff:10.0.0.1')) && !isLoopback({ headers: {} }), 'non-loopback');
  const auth = new HostAuth({ token: 'tok-secret', hostRemote: false });
  check(auth.exchange('wrong', req()) === null && auth.exchange(undefined, req()) === null, 'wrong token refused');
  check(auth.exchange('tok-secret', req({}, '10.0.0.2')) === null, 'exchange from a non-loopback peer refused');
  const sid = auth.exchange('tok-secret', req());
  check(typeof sid === 'string' && sid !== 'tok-secret', 'session id differs from the token');
  const cookie = auth.sessionCookie(sid);
  check(cookie.startsWith(`${HOST_COOKIE}=`) && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && !cookie.includes('tok-secret'), 'host cookie flags');
  const hostReq = (addr) => req({ cookie: `${HOST_COOKIE}=${sid}` }, addr);
  check(auth.requireHost(hostReq('127.0.0.1')).ok, 'cookie + loopback passes');
  check(auth.requireHost(hostReq('::1')).ok, 'cookie + ::1 passes');
  check(auth.requireHost(hostReq('10.0.0.2')).status === 403, 'cookie from LAN refused');
  check(auth.requireHost(req()).status === 403, 'loopback without cookie refused');
  check(auth.requireHost(req({ cookie: `${HOST_COOKIE}=nope` })).status === 403, 'bad cookie refused');
  check(auth.requireHost(req({ cookie: `${HOST_COOKIE}=tok-secret` })).status === 403, 'the raw token is not a session');
  const remote = new HostAuth({ token: 'tok-secret', hostRemote: true });
  const sid2 = remote.exchange('tok-secret', req({}, '10.0.0.2'));
  check(sid2 && remote.requireHost(req({ cookie: `${HOST_COOKIE}=${sid2}` }, '10.0.0.2')).ok, 'HOST_REMOTE lifts the loopback rule');
  check(remote.requireHost(req({}, '10.0.0.2')).status === 403, 'HOST_REMOTE still needs the cookie');
  process.env.HOST_REMOTE = '1';
  const envAuth = new HostAuth({ token: 't' });
  check(envAuth.exchange('t', req({}, '10.0.0.2')) !== null, 'HOST_REMOTE=1 env read');
  delete process.env.HOST_REMOTE;
  check(envAuth.exchange('t', req({}, '10.0.0.2')) === null, 'HOST_REMOTE env is read at call time');
  auth.revoke(hostReq());
  check(auth.requireHost(hostReq()).status === 403, 'revoked session');
}

// ---- origin, names ----
{
  check(checkOrigin(req({ origin: 'http://localhost:3100' }), 'http://localhost:3100'), 'same origin passes');
  check(!checkOrigin(req({ origin: 'http://evil.example' }), 'http://localhost:3100'), 'foreign origin refused');
  check(!checkOrigin(req({ origin: 'null' }), 'http://localhost:3100'), 'null origin refused');
  check(!checkOrigin(req({}), 'http://localhost:3100') && checkOrigin(req({}), 'http://localhost:3100', { allowMissing: true }), 'missing origin policy');
  check(checkOrigin(req({ origin: 'http://127.0.0.1:3100' }), ['http://localhost:3100', 'http://127.0.0.1:3100']), 'origin list');
  check(sanitiseName('  Ana \n  Bell ').name === 'Ana Bell', 'name whitespace collapsed');
  check(sanitiseName('a‮b​c\u0007').name === 'abc', 'bidi, zero-width, control stripped');
  check(sanitiseName('').error && sanitiseName('  \n ').error && sanitiseName(5).error, 'empty / non-string refused');
  check(sanitiseName('x'.repeat(20)).name && sanitiseName('x'.repeat(21)).error, '20 characters at most');
}

// ---- rate limits ----
{
  let t = 0;
  const rl = new RateLimiter({ limits: { create: { capacity: 2, perSecond: 1 }, join: { capacity: 1, perSecond: 0.5 } }, now: () => t });
  check(rl.take('create', 'a').ok && rl.take('create', 'a').ok, 'burst allowed');
  const denied = rl.take('create', 'a');
  check(!denied.ok && denied.retryMs === 1000, 'third refused with retry time');
  check(rl.take('create', 'b').ok, 'other address has its own bucket');
  check(rl.take('join', 'a').ok, 'other class has its own bucket');
  t = 999;
  check(!rl.take('create', 'a').ok, 'not yet refilled');
  t = 1000;
  check(rl.take('create', 'a').ok, 'refilled after a second');
  t = 1000 + 3600e3;
  rl.take('create', 'zzz');
  check(rl.size === 1, `idle buckets swept (size ${rl.size})`);
  try { rl.take('nope', 'a'); fail('unknown class'); } catch { /* expected */ }
}

// ---- logger ----
{
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l), now: () => 0, base: { svc: 'x' } });
  log.info('hello', { game: 'gm_1', key: 'sk-1', apiKey: 'sk-2', headers: { authorization: 'Bearer z', ok: 1 }, body: '{"a":1}', token: 't', note: 'fine', list: [{ cookie: 'c', n: 2 }] });
  const e = JSON.parse(lines[0]);
  check(e.msg === 'hello' && e.game === 'gm_1' && e.note === 'fine' && e.svc === 'x' && e.level === 'info', 'log keeps ordinary fields');
  check(!/sk-|Bearer|"t":"t"|"c":"c"|\{\\"a\\":1\}/.test(lines[0]), 'log holds no secret value');
  check(e.headers.ok === 1 && e.list[0].n === 2 && e.redacted.length === 6, `log redacts by name (${e.redacted})`);
  log.child({ g: 1 }).warn('w', { error: new Error('boom') });
  check(JSON.parse(lines[1]).g === 1 && JSON.parse(lines[1]).error.message === 'boom', 'child logger and errors');
}

// ---- settings service ----
{
  const dir = mkdtempSync(join(tmpdir(), 'jd-auth-'));
  const store = new FileStore(join(dir, 's'));
  const svc = new SettingsService(store, { path: null });
  const first = svc.get();
  check(first.revision === 1 && store.currentRevision().revision === 1, 'seeded revision 1');
  check(first.values.lives === 4 && Array.isArray(first.schema) && first.schema.length > 20, 'defaults and schema');
  check(EDITABLE_KEYS.every((k) => !/^ui_/.test(k) && !/endpoint/i.test(k) && !['openaiDecisionModel', 'layaModel'].includes(k)), 'UI / Decision / endpoint knobs excluded');
  check(!('layaEndpoint' in first.values) && !first.schema.some((r) => r.group === 'UI' || r.group === 'Decision'), 'excluded keys absent from get()');
  const snap = svc.rulesForNewGame();
  check(snap.rules_revision === 1 && Object.isFrozen(snap.rules), 'rules snapshot frozen');
  let threw = false;
  try { 'use strict'; snap.rules.lives = 9; } catch { threw = true; }
  check(snap.rules.lives === 4, `frozen snapshot cannot change (threw=${threw})`);
  const ok = svc.put({ lives: 3, speed: 0.8 });
  check(ok.ok && ok.changed && ok.revision === 2 && svc.get().values.lives === 3 && svc.get().revision === 2, 'put publishes revision 2');
  check(store.readRevision(2).values.speed === 0.8 && store.readRevision(1).values.lives === 4, 'revisions stored, old one untouched');
  check(snap.rules.lives === 4 && snap.rules_revision === 1, 'earlier snapshot unaffected by the put');
  check(svc.rulesForNewGame().rules.lives === 3 && svc.rulesForNewGame().rules_revision === 2, 'new snapshot sees the new revision');
  const same = svc.put({ lives: 3 });
  check(same.ok && !same.changed && same.revision === 2 && readdirSync(join(store.root, 'settings')).length === 2, 'identical put publishes nothing');
  const bad = svc.put({ lives: 99, nope: 1, ui_camMs: 5, speed: 0.7 });
  check(!bad.ok && bad.status === 400 && bad.fields.lives && bad.fields.nope === 'unknown setting' && bad.fields.ui_camMs && !bad.fields.speed, 'field errors, per field');
  check(svc.get().revision === 2 && svc.get().values.speed === 0.8, 'a rejected put changes nothing');
  check(!svc.put('x').ok && !svc.put([1]).ok, 'non-object refused');
  const reopened = new SettingsService(store, { path: null });
  check(reopened.get().revision === 2 && reopened.get().values.lives === 3, 'a restart keeps the last revision');
  rmSync(dir, { recursive: true, force: true });
}

// ---- router, send, readJson ----
{
  const r = new Router().add('POST', '/v1/games/:id/join', () => 'join').add('GET', '/v1/games/:id', () => 'get');
  const m = r.match('POST', '/v1/games/gm_x%20y/join');
  check(m.handler() === 'join' && m.params.id === 'gm_x y', 'route params');
  check(r.match('GET', '/v1/games/gm_1/').handler() === 'get', 'trailing slash');
  check(r.match('GET', '/v1/games/gm_1/join').status === 405 && r.match('GET', '/v1/games/gm_1/join').allow[0] === 'POST', '405 with allow');
  check(r.match('GET', '/nope').status === 404, '404');
  const server = http.createServer(async (rq, rs) => {
    try { send(rs, 200, await readJson(rq, { limit: 100 })); } catch (e) { send(rs, e instanceof HttpError ? e.status : 500, { error: e.message }); }
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => { const x = await fetch(base, { method: 'POST', body }); return [x.status, await x.json()]; };
  // the tripwire replaced fetch: use http.request instead
  const call = (body) => new Promise((res, rej) => {
    const q = http.request(base, { method: 'POST' }, (rs) => { let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => res([rs.statusCode, JSON.parse(s), rs.headers])); });
    q.on('error', rej);
    q.end(body);
  });
  void post;
  const ok = await call('{"a":1}');
  check(ok[0] === 200 && ok[1].a === 1 && ok[2]['cache-control'] === 'no-store', 'json round trip');
  check((await call('{nope'))[0] === 400 && (await call('[1]'))[0] === 400, 'bad json / non-object 400');
  check((await call(JSON.stringify({ pad: 'x'.repeat(300) })))[0] === 413, 'too large 413');
  server.close();
}

// ---- SSE ----
{
  let sse = null;
  let closedWhy = null;
  const server = http.createServer((rq, rs) => {
    sse = openSse(rq, rs, { heartbeatMs: 40, maxQueuedBytes: 200 * 1024, onClose: (w) => { closedWhy = w; } });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  let text = '';
  let clientRes = null;
  await new Promise((res) => {
    const q = http.get({ host: '127.0.0.1', port, headers: { 'Last-Event-ID': '41' } }, (rs) => { clientRes = rs; rs.on('data', (c) => (text += c)); res(); });
    q.on('error', () => {});
  });
  await sleep(30);
  check(sse && sse.lastEventId === '41', 'Last-Event-ID passed through');
  check(clientRes.headers['content-type'].startsWith('text/event-stream'), 'event-stream content type');
  check(sse.send({ id: 42, event: 'tick', data: { n: 1, s: 'a\nb' } }), 'send ok');
  await sleep(120);
  check(text.includes('id: 42\nevent: tick\ndata: {"n":1,"s":"a\\nb"}\n\n'), 'frame format, newline escaped in data');
  check((text.match(/: heartbeat/g) ?? []).length >= 2, 'heartbeats arrive');
  // overflow: stop reading, push until the bound trips
  clientRes.pause();
  const big = { pad: 'x'.repeat(60 * 1024) };
  let sent = 0;
  while (!sse.closed && sent < 2000) { sse.send({ id: 100 + sent, data: big }); sent++; if (sent % 20 === 0) await sleep(1); }
  check(sse.closed && sse.reason === 'overflow' && closedWhy === 'overflow', `slow client closed on overflow after ${sent} frames`);
  check(!sse.send({ data: 1 }), 'send after close is refused');
  clientRes.destroy();
  server.closeAllConnections?.();
  server.close();
  // client disconnect closes the helper
  let s2 = null;
  const server2 = http.createServer((rq, rs) => { s2 = openSse(rq, rs, { heartbeatMs: 1000 }); });
  await new Promise((res) => server2.listen(0, '127.0.0.1', res));
  const cr = await new Promise((res) => { const q = http.get({ host: '127.0.0.1', port: server2.address().port }, res); q.on('error', () => {}); });
  await sleep(20);
  cr.destroy();
  await sleep(60);
  check(s2.closed && s2.reason === 'client', 'client disconnect closes the stream');
  server2.closeAllConnections?.();
  server2.close();
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('All auth/service-plumbing checks passed.');
