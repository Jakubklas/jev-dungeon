// Checks for the hosted service's file store (src/service/store.js): atomic writes, lock refusal and takeover,
// host token mode, append-only settings revisions, event replay, cold snapshots, the calls.jsonl recorder.
// Free, no Jev, no network: node scripts/check-store.mjs
import { installTripwire } from './lib/tripwire.mjs';
installTripwire();

import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, CallsRecorder, StoreError } from '../src/service/store.js';

let failures = 0;
const fail = (m) => { failures++; if (failures <= 30) console.error('FAIL:', m); };
const check = (ok, m) => ok || fail(m);
const throws = (fn, re, m) => { try { fn(); fail(`${m}: expected a throw`); } catch (e) { check(!re || re.test(e.message), `${m}: wrong error ${e.message}`); } };
const root = mkdtempSync(join(tmpdir(), 'jd-store-'));

// ---- lock ----
{
  const a = new FileStore(join(root, 'a'));
  a.lock();
  check(readFileSync(join(a.root, 'server.lock'), 'utf8').trim() === String(process.pid), 'lock holds our pid');
  const b = new FileStore(join(root, 'a'), { isAlive: () => true });
  // A second store in this process must not take over an active lock just because the pid matches.
  throws(() => b.lock(), /another store in this process/, 'same-process second store refuses');
  a.unlock();
  check(!existsSync(join(a.root, 'server.lock')), 'unlock removes the lock');
  // A different live pid also refuses.
  writeFileSync(join(a.root, 'server.lock'), '999999\n');
  const live = new FileStore(join(root, 'a'), { isAlive: (p) => p === 999999 });
  throws(() => live.lock(), /another server \(pid 999999\)/, 'live other pid refuses');
  check(readFileSync(join(a.root, 'server.lock'), 'utf8').trim() === '999999', 'a refused lock leaves the file');
  const stale = new FileStore(join(root, 'a'), { isAlive: () => false });
  stale.lock();
  check(readFileSync(join(a.root, 'server.lock'), 'utf8').trim() === String(process.pid), 'stale lock taken over');
  stale.unlock();
  writeFileSync(join(a.root, 'server.lock'), 'garbage');
  const g = new FileStore(join(root, 'a'));
  g.lock();
  check(true, 'garbage lock taken over');
  g.unlock();
  // a real dead pid
  writeFileSync(join(a.root, 'server.lock'), '2147483646\n');
  new FileStore(join(root, 'a')).lock();
  check(true, 'real dead pid taken over');
}

// ---- host token ----
{
  const s = new FileStore(join(root, 'h'));
  const t1 = s.hostToken();
  const t2 = s.hostToken();
  check(t1 !== t2 && t1.length >= 40, 'fresh random token each call');
  const path = join(s.root, 'host-token');
  check((statSync(path).mode & 0o777) === 0o600, 'host-token mode 0600');
  check(readFileSync(path, 'utf8').trim() === t2, 'file holds the latest token');
  check(s.hostToken({ pinned: 'pin-1' }) === 'pin-1' && readFileSync(path, 'utf8').trim() === 'pin-1', 'pinned token');
  check((statSync(path).mode & 0o777) === 0o600, 'pinned token mode 0600');
}

// ---- settings revisions ----
{
  const s = new FileStore(join(root, 'r'));
  check(s.currentRevision() === null, 'no revision yet');
  const r1 = s.publishRevision({ lives: 4 });
  const r2 = s.publishRevision({ lives: 3 });
  const r3 = s.publishRevision({ lives: 2 });
  check(r1.revision === 1 && r2.revision === 2 && r3.revision === 3, 'revisions increase by one');
  check(s.currentRevision().revision === 3 && s.currentRevision().values.lives === 2, 'current is the last');
  check(s.readRevision(1).values.lives === 4, 'old revision untouched');
  check(s.readRevision(9) === null, 'missing revision is null');
  check(readdirSync(join(s.root, 'settings')).sort().join() === '1.json,2.json,3.json', 'only revision files remain (no temp files)');
  throws(() => s.readRevision(0), /bad revision/, 'revision 0');
  check(new FileStore(join(root, 'r')).publishRevision({}).revision === 4, 'a new store continues the numbering');
}

// ---- games ----
{
  const s = new FileStore(join(root, 'g'));
  s.createGameDir('gm_one');
  throws(() => s.createGameDir('gm_one'), null, 'duplicate game dir');
  throws(() => s.createGameDir('../evil'), /bad game id/, 'path traversal id');
  throws(() => s.writeJson('gm_one', 'secret.json', {}), /not a game file/, 'unknown file name');
  s.writeJson('gm_one', 'meta.json', { status: 'running' });
  s.writeJson('gm_one', 'rules.json', { rules_revision: 1 });
  s.writeJson('gm_one', 'dungeon.json', { tiles: [] });
  s.writeJson('gm_one', 'state.json', { event_seq: 2, v: 1 });
  check(readdirSync(join(s.root, 'games', 'gm_one')).every((f) => !f.includes('.tmp-')), 'no temp files left after writes');
  s.writeJson('gm_one', 'state.json', { event_seq: 2, v: 2 });
  check(JSON.parse(readFileSync(join(s.root, 'games', 'gm_one', 'state.json'), 'utf8')).v === 2, 'state.json replaced');
  for (let seq = 1; seq <= 4; seq++) s.appendEvent('gm_one', { seq, type: 'move' });
  throws(() => s.appendEvent('gm_one', { type: 'x' }), /seq/, 'event without seq');
  check(s.readEvents('gm_one').length === 4, 'four events');
  check(s.readEvents('gm_one', { afterSeq: 2 }).map((e) => e.seq).join() === '3,4', 'afterSeq filter');
  const g = s.readGame('gm_one');
  check(g.events.map((e) => e.seq).join() === '1,2' && g.dropped === 2, 'events above state.event_seq are dropped and counted');
  check(g.meta.status === 'running' && g.rules.rules_revision === 1 && g.state.v === 2 && Array.isArray(g.dungeon.tiles), 'readGame returns the files');
  // a torn last line is ignored
  writeFileSync(join(s.root, 'games', 'gm_one', 'events.jsonl'), '{"seq":1}\n{"seq":2', { flag: 'a' });
  check(s.readEvents('gm_one').length === 3, 'torn last line skipped after uncommitted events were truncated');
  // crash between append and state write: event 5 is on disk, state still says 4 -> 5 dropped
  s.writeJson('gm_one', 'state.json', { event_seq: 4 });
  s.createGameDir('gm_two');
  s.appendEvent('gm_two', { seq: 1 });
  const noState = s.readGame('gm_two');
  check(noState.state === null && noState.events.length === 0 && noState.dropped === 1 && s.readEvents('gm_two').length === 0, 'no state yet: nothing replays');
  s.writeCold('gm_one', 12, { event_seq: 12 });
  check(existsSync(join(s.root, 'games', 'gm_one', 'state-12.json')), 'cold snapshot state-<seq>.json');
  throws(() => s.writeCold('gm_one', -1, {}), /bad snapshot/, 'bad cold seq');
  check(s.listGames().join() === 'gm_one,gm_two', 'listGames');
}

// ---- calls recorder ----
{
  const s = new FileStore(join(root, 'c'));
  s.createGameDir('gm_c');
  const rec = new CallsRecorder(s, 'gm_c');
  const h = rec.record({ at: 1, game: 'gm_c', actor: 'p1', kind: 'tick', attempt: 1, outcome: 'pending' });
  check(rec.read().length === 0, 'a pending call is not a line yet');
  rec.update(h, { status: 200, bytes_out: 100, bytes_in: 50, ms: 12, outcome: 'ok' });
  rec.update(h, { ms: 13 });
  const lines = rec.read();
  check(lines.length === 1 && lines[0].outcome === 'ok' && lines[0].status === 200, 'finished call appended once');
  const allowed = new Set(['at', 'game', 'actor', 'kind', 'attempt', 'status', 'bytes_out', 'bytes_in', 'ms', 'outcome']);
  check(Object.keys(lines[0]).every((k) => allowed.has(k)), 'only allowlisted fields');
  throws(() => rec.record({ at: 1, outcome: 'ok', body: '{}' }), /never holds "body"/, 'body field refused');
  throws(() => rec.update(h, { authorization: 'Bearer x' }), /never holds/, 'authorization refused');
  throws(() => rec.record({ outcome: 'ok', api_key: 'k' }), /never holds/, 'api_key refused');
  rec.record({ at: 2, game: 'gm_c', actor: 'a1', kind: 'adv', outcome: 'ok', extra: 'dropped' });
  const raw = readFileSync(join(s.root, 'games', 'gm_c', 'calls.jsonl'), 'utf8');
  check(raw.split('\n').filter(Boolean).length === 2 && !raw.includes('extra') && !/bearer|api_key/i.test(raw), 'unknown fields stripped; no key material on disk');
  throws(() => new CallsRecorder(s, '../x'), /bad game id/, 'recorder id validated');
}

rmSync(root, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('All store checks passed.');
