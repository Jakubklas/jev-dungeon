// Hosted /v1 smoke and access checks. Workers use stub decisions; no external fetch may occur.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTripwire } from './lib/tripwire.mjs';

process.env.JEV_TEST_STUB = '1';
process.env.JEV_CONFIG = 'none';
const uninstall = installTripwire();
const { HostedService } = await import('../src/service/service.js');
const root = mkdtempSync(join(tmpdir(), 'jev-service-'));
let service = new HostedService({ root, port: 0, settingsPath: null });
let address = await service.listen();
let origin = `http://127.0.0.1:${address.port}`;

function call(method, path, body = null, { cookie = '', host = false, originHeader = origin, extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const req = httpRequest(`${origin}${path}`, { method, headers: {
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      ...(method !== 'GET' && originHeader ? { origin: originHeader } : {}),
      ...(cookie ? { cookie } : {}),
      ...extraHeaders,
    } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null, cookies: res.headers['set-cookie'] ?? [] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

try {
  assert.equal((await call('GET', '/health')).body.ok, true);
  assert.equal((await call('POST', '/v1/games', { name: 'Mira', key: 'private-secret', mode: 'private' },
    { originHeader: 'http://evil.invalid' })).status, 403);
  assert.equal((await call('POST', '/v1/origin-check', null, {
    originHeader: 'https://evil.invalid',
    extraHeaders: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.invalid' },
  })).status, 403, 'forwarding headers cannot authorize an arbitrary origin');
  const proxyRoot = mkdtempSync(join(tmpdir(), 'jev-service-proxy-'));
  const proxy = new HostedService({ root: proxyRoot, port: 0, settingsPath: null,
    publicOrigin: 'https://game.example' });
  const localOrigin = origin;
  try {
    const proxyAddress = await proxy.listen();
    origin = `http://127.0.0.1:${proxyAddress.port}`;
    assert.equal((await call('POST', '/v1/origin-check', null,
      { originHeader: 'https://game.example' })).status, 404, 'public HTTPS origin passes over internal HTTP');
    for (const rejected of [origin, 'http://game.example', 'https://evil.invalid', 'null'])
      assert.equal((await call('POST', '/v1/origin-check', null,
        { originHeader: rejected })).status, 403, 'only the configured public origin is allowed');
    assert.throws(() => new HostedService({ publicOrigin: 'https://game.example/path' }), /PUBLIC_ORIGIN/);
  } finally {
    origin = localOrigin;
    await proxy.close();
    rmSync(proxyRoot, { recursive: true, force: true });
  }
  const created = await call('POST', '/v1/games', { name: 'Mira', key: 'private-secret', mode: 'private' });
  assert.equal(created.status, 201);
  const id = created.body.game.id;
  const memberCookie = created.cookies[0].split(';')[0];
  assert.equal((await call('GET', `/v1/games/${id}`)).status, 403);
  const view = await call('GET', `/v1/games/${id}`, null, { cookie: memberCookie });
  assert.equal(view.status, 200);
  assert.equal(view.body.self, created.body.participant_id);
  assert.notEqual(memberCookie.split('=')[1], created.body.participant_id, 'public actor id must differ from the cookie credential');
  const forged = `${memberCookie.split('=')[0]}=${created.body.participant_id}`;
  assert.equal((await call('GET', `/v1/games/${id}`, null, { cookie: forged })).status, 403);
  assert.ok(view.body.tiles.flat().some((c) => c === null));
  assert.equal('seed' in view.body, false);
  assert.equal((await call('GET', '/v1/host/games', null, { cookie: memberCookie })).status, 403);
  const session = await call('POST', '/v1/host/session', { token: service.hostToken });
  assert.equal(session.status, 200);
  const hostCookie = session.cookies[0].split(';')[0];
  for (const [method, path] of [
    ['GET', '/v1/host/settings'], ['PUT', '/v1/host/settings'], ['GET', '/v1/host/metrics'],
    ['GET', `/v1/host/games/${id}/calls`], ...['pause', 'resume', 'end', 'reveal'].map((op) => ['POST', `/v1/host/games/${id}/${op}`]),
  ]) assert.equal((await call(method, path, method === 'GET' ? null : {}, { cookie: memberCookie })).status, 403, `${method} ${path}`);
  const games = await call('GET', '/v1/host/games', null, { cookie: hostCookie });
  assert.equal(games.status, 200);
  assert.ok(games.body.games.some((g) => g.id === id));
  assert.equal((await call('GET', '/v1/host/settings', null, { cookie: hostCookie })).status, 200);
  const metrics = await call('GET', '/v1/host/metrics', null, { cookie: hostCookie });
  assert.equal(metrics.status, 200);
  for (const key of ['posts', 'latency_p50_ms', 'latency_p95_ms', 'actor_queue_delay_ms', 'event_write_delay_ms', 'sse_lag_ms', 'sse_clients'])
    assert.equal(typeof metrics.body[key], 'number', `metrics field ${key}`);
  assert.equal((await call('POST', `/v1/games/${id}/directives`, { text: 'toward the portal' }, { cookie: memberCookie })).status, 200);
  assert.equal((await call('POST', `/v1/games/${id}/directives`, { text: 'again' }, { cookie: memberCookie })).status, 429);
  const paused = await call('POST', `/v1/games/${id}/pause`, {}, { cookie: memberCookie });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.game.status, 'paused');
  assert.equal((await call('POST', `/v1/games/${id}/resume`, {}, { cookie: memberCookie })).status, 200);
  const room = await call('POST', '/v1/games', { name: 'Ada', key: 'ada-secret', mode: 'shared' });
  assert.equal(room.status, 201);
  const roomId = room.body.game.id;
  const leaderCookie = room.cookies[0].split(';')[0];
  const joined = await call('POST', `/v1/games/${roomId}/join`, { name: 'Bryn', key: 'bryn-secret' });
  assert.equal(joined.status, 200);
  const secondCookie = joined.cookies[0].split(';')[0];
  assert.equal((await call('POST', `/v1/games/${roomId}/start`, {}, { cookie: secondCookie })).status, 403);
  assert.equal((await call('POST', `/v1/games/${roomId}/start`, {}, { cookie: leaderCookie })).status, 200);
  assert.equal((await call('POST', `/v1/games/${roomId}/join`, { name: 'Late', key: 'late' })).status, 409);
  const one = (await call('GET', `/v1/games/${roomId}`, null, { cookie: leaderCookie })).body;
  const two = (await call('GET', `/v1/games/${roomId}`, null, { cookie: secondCookie })).body;
  assert.equal(one.explorers.length, 2);
  assert.notDeepEqual(one.explorers[0].pos, one.explorers[1].pos);
  assert.equal(one.lobby.participants.filter((p) => p.is_self).length, 1);
  assert.equal(two.lobby.participants.filter((p) => p.is_self).length, 1);
  assert.notEqual(one.self, two.self);
  assert.equal((await call('POST', `/v1/games/${roomId}/start`, {},
    { cookie: `${leaderCookie.split('=')[0]}=${room.body.game.leader}` })).status, 403, 'public leader id is not an authentication token');
  assert.equal((await call('POST', `/v1/games/${roomId}/pause`, {}, { cookie: leaderCookie })).status, 403);
  assert.equal((await call('GET', `/v1/host/games/${roomId}/calls`, null, { cookie: secondCookie })).status, 403);
  assert.equal((await call('POST', `/v1/host/games/${roomId}/pause`, {}, { cookie: hostCookie })).status, 200);
  assert.equal((await call('POST', `/v1/host/games/${roomId}/reveal`, {}, { cookie: hostCookie })).status, 200);
  await service.close();
  service = new HostedService({ root, port: 0, settingsPath: null });
  address = await service.listen();
  origin = `http://127.0.0.1:${address.port}`;
  const resumed = await call('GET', `/v1/games/${roomId}`, null, { cookie: leaderCookie });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.lobby.status, 'paused');
  assert.equal(resumed.body.lobby.pause_reason, 'keys_needed');
  assert.equal(resumed.body.lobby.participants.some((p) => p.key_present), false);
  assert.equal((await call('POST', `/v1/games/${roomId}/key`, { key: 'ada-new' }, { cookie: leaderCookie })).status, 200);
  assert.equal((await call('POST', `/v1/games/${roomId}/key`, { key: 'bryn-new' }, { cookie: secondCookie })).status, 200);
  assert.equal((await call('GET', `/v1/games/${roomId}`, null, { cookie: leaderCookie })).body.lobby.status, 'running');
  const restartedSession = await call('POST', '/v1/host/session', { token: service.hostToken });
  const restartedHostCookie = restartedSession.cookies[0].split(';')[0];
  assert.equal((await call('POST', `/v1/host/games/${id}/end`, {}, { cookie: restartedHostCookie })).status, 200);
  const ended = (await call('GET', `/v1/games/${id}`, null, { cookie: memberCookie })).body;
  assert.equal(ended.result, 'host_ended');
  assert.equal(ended.ranking.length, 1);
  const files = ['meta.json', 'rules.json', 'dungeon.json', 'state.json', 'events.jsonl'];
  for (const file of files) assert.doesNotMatch(readFileSync(join(root, 'games', id, file), 'utf8'), /private-secret/);
  console.log('hosted service: private/shared games, fog, auth, origin, directives, pause/resume, restart, no key on disk: ok');
} finally {
  await service.close();
  uninstall();
  delete process.env.JEV_TEST_STUB;
  rmSync(root, { recursive: true, force: true });
}
