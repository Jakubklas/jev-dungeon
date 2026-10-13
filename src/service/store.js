// File store for the hosted service (PLAN-multiplayer "Storage and recovery"). One server process, one folder:
//   server.lock, host-token, settings/<rev>.json (append-only), games/<id>/{meta,rules,dungeon,state}.json,
//   events.jsonl, calls.jsonl, state-<seq>.json (cold snapshots).
// ORDERING CONTRACT (the game actor is the only writer of its folder): for each applied action
//   1. appendEvent(id, event)   2. writeJson(id, 'state.json', state)   3. the CALLER publishes (SSE).
// state.json (temp file + rename, so a crash leaves the old or the new one) is the truth: on restore readGame drops
// events whose seq is above state.event_seq, so an action is never applied twice. Keys are never stored: nothing here
// takes one, and CallsRecorder keeps only the gateway's field allowlist (never a body, never a key).
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEntry } from '../gateway/recorder.js';

export const DEFAULT_ROOT = fileURLToPath(new URL('../../runs/server/', import.meta.url));
const JSON_FILES = new Set(['meta.json', 'rules.json', 'dungeon.json', 'state.json']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_CALL_FIELDS = /^(key|api_key|apikey|authorization|token|body|request|response|headers|cookie)$/i;
const HELD_ROOTS = new Set();

export class StoreError extends Error {}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Writes `data` to a sibling temp file, fsyncs it, then renames it over `path`.
function atomicWrite(path, data, mode) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'w', mode);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export class FileStore {
  root;
  #isAlive;
  #locked = false;

  // opts.isAlive(pid) -> boolean replaces the process check (checks use it to fake a live or dead other server).
  constructor(root = DEFAULT_ROOT, { isAlive = pidAlive } = {}) {
    this.root = resolve(root);
    this.#isAlive = isAlive;
    mkdirSync(join(this.root, 'games'), { recursive: true });
    mkdirSync(join(this.root, 'settings'), { recursive: true });
  }

  // ---------- lock ----------
  lock() {
    if (HELD_ROOTS.has(this.root)) throw new StoreError(`another store in this process holds ${this.root}`);
    const path = join(this.root, 'server.lock');
    if (existsSync(path)) {
      let other = NaN;
      try { other = Number(readFileSync(path, 'utf8').trim()); } catch { /* unreadable: treat as stale */ }
      if (Number.isInteger(other) && other > 0 && other !== process.pid && this.#isAlive(other)) {
        throw new StoreError(`another server (pid ${other}) holds ${path}`);
      }
      unlinkSync(path); // stale (dead pid, garbage) or ours from an earlier run: take it over
    }
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') throw new StoreError(`another server took ${path} just now`);
      throw err;
    }
    this.#locked = true;
    HELD_ROOTS.add(this.root);
  }

  unlock() {
    if (!this.#locked) return;
    const path = join(this.root, 'server.lock');
    try {
      if (Number(readFileSync(path, 'utf8').trim()) === process.pid) unlinkSync(path);
    } catch { /* already gone */ }
    this.#locked = false;
    HELD_ROOTS.delete(this.root);
  }

  // ---------- host token ----------
  // A fresh random token per call unless `pinned` (HOST_TOKEN); the file is mode 0600.
  hostToken({ pinned } = {}) {
    const token = pinned ? String(pinned) : randomBytes(32).toString('base64url');
    const path = join(this.root, 'host-token');
    atomicWrite(path, token + '\n', 0o600);
    chmodSync(path, 0o600);
    return token;
  }

  // ---------- settings revisions (append-only) ----------
  #revisions() {
    return readdirSync(join(this.root, 'settings')).map((f) => /^(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  }

  // Writes settings/<n>.json with n = highest + 1. A hard link makes "never overwrite" atomic even against a racer.
  publishRevision(values) {
    for (let tries = 0; tries < 20; tries++) {
      const revs = this.#revisions();
      const revision = (revs.at(-1) ?? 0) + 1;
      const final = join(this.root, 'settings', `${revision}.json`);
      const tmp = `${final}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      const fd = openSync(tmp, 'w');
      try { writeSync(fd, JSON.stringify({ revision, values }, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      try {
        linkSync(tmp, final);
        return { revision, values };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      } finally {
        unlinkSync(tmp);
      }
    }
    throw new StoreError('could not publish a settings revision');
  }

  currentRevision() {
    const n = this.#revisions().at(-1);
    return n === undefined ? null : this.readRevision(n);
  }

  readRevision(n) {
    if (!Number.isInteger(n) || n < 1) throw new StoreError(`bad revision ${n}`);
    const path = join(this.root, 'settings', `${n}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  // ---------- games ----------
  #dir(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new StoreError(`bad game id ${JSON.stringify(id)}`);
    return join(this.root, 'games', id);
  }

  createGameDir(id) {
    const dir = this.#dir(id);
    mkdirSync(dir, { recursive: false });
    return dir;
  }

  writeJson(id, name, obj) {
    if (!JSON_FILES.has(name) && !/^state-\d+\.json$/.test(name)) throw new StoreError(`not a game file: ${name}`);
    atomicWrite(join(this.#dir(id), name), JSON.stringify(obj) + '\n');
  }

  #readJson(id, name) {
    const path = join(this.#dir(id), name);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }

  // Events carry a numeric `seq`. One JSON line, fsynced.
  appendEvent(id, event) {
    if (!Number.isInteger(event?.seq)) throw new StoreError('an event needs an integer seq');
    const fd = openSync(join(this.#dir(id), 'events.jsonl'), 'a');
    try { writeSync(fd, JSON.stringify(event) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  }

  readEvents(id, { afterSeq = -Infinity } = {}) {
    const path = join(this.#dir(id), 'events.jsonl');
    if (!existsSync(path)) return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; } // a torn last line from a crash
      if (e.seq > afterSeq) out.push(e);
    }
    return out;
  }

  writeCold(id, seq, state) {
    if (!Number.isInteger(seq) || seq < 0) throw new StoreError(`bad snapshot seq ${seq}`);
    this.writeJson(id, `state-${seq}.json`, state);
  }

  listGames() {
    return readdirSync(join(this.root, 'games'), { withFileTypes: true }).filter((d) => d.isDirectory() && ID_RE.test(d.name)).map((d) => d.name).sort();
  }

  // -> { meta, rules, dungeon, state, events, dropped }: events above state.event_seq are not returned but counted.
  readGame(id) {
    const state = this.#readJson(id, 'state.json');
    const all = this.readEvents(id);
    const cut = state?.event_seq ?? 0;
    const events = all.filter((e) => e.seq <= cut);
    // A crash may leave an appended event without its state write. Remove it before new events reuse that seq.
    // Also strips a torn final line. The lock makes this the only writer during recovery.
    const eventPath = join(this.#dir(id), 'events.jsonl');
    if (existsSync(eventPath)) {
      const canonical = events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
      if (readFileSync(eventPath, 'utf8') !== canonical) atomicWrite(eventPath, canonical);
    }
    return {
      meta: this.#readJson(id, 'meta.json'),
      rules: this.#readJson(id, 'rules.json'),
      dungeon: this.#readJson(id, 'dungeon.json'),
      state,
      events,
      dropped: all.length - events.length,
    };
  }
}

// The gateway's recorder interface (src/gateway/recorder.js) over calls.jsonl. A pending entry lives in memory and the
// line is appended when it finishes (outcome other than 'pending'), so every line is complete. Only the gateway's field
// allowlist is written; a key-like or body-like field is a programming error and throws.
export class CallsRecorder {
  #store;
  #id;
  constructor(store, gameId) {
    this.#store = store;
    this.#id = gameId;
    if (!ID_RE.test(gameId)) throw new StoreError(`bad game id ${JSON.stringify(gameId)}`);
    mkdirSync(join(store.root, 'games', gameId), { recursive: true });
  }

  #assertClean(obj) {
    for (const k of Object.keys(obj)) if (FORBIDDEN_CALL_FIELDS.test(k)) throw new StoreError(`calls.jsonl never holds "${k}"`);
  }

  #append(e) {
    const fd = openSync(join(this.#store.root, 'games', this.#id, 'calls.jsonl'), 'a');
    try { writeSync(fd, JSON.stringify(e) + '\n'); } finally { closeSync(fd); }
  }

  record(entry) {
    this.#assertClean(entry);
    const handle = cleanEntry(entry);
    if (handle.outcome !== undefined && handle.outcome !== 'pending') this.#append(handle);
    return handle;
  }

  update(handle, patch) {
    this.#assertClean(patch);
    const was = handle.outcome;
    Object.assign(handle, cleanEntry(patch));
    if (handle.outcome !== undefined && handle.outcome !== 'pending' && (was === undefined || was === 'pending')) this.#append(handle);
  }

  // The finished lines, for the host's call log.
  read() {
    const path = join(this.#store.root, 'games', this.#id, 'calls.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
}
