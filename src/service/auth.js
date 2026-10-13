// Identity for the hosted service, with no accounts.
//  - Participants: a private random `par_` token (distinct from the public participant id) in an HttpOnly,
//    SameSite=Strict cookie `jd_par_<gameId>`. The service stores its private mapping in meta.json. A cookie has one Path,
//    so joining sets two (participantCookies): /v1/games/<id> for the API and the page path for the play page.
//  - Host: a random token printed once as /host#token=...; the page POSTs it to /v1/host/session (HostAuth.exchange),
//    which answers with an HttpOnly `jd_host` cookie holding a random session id. requireHost needs that cookie AND a
//    loopback peer, unless HOST_REMOTE=1. All secret compares are constant-time.
//  - checkOrigin: mutating routes must carry an Origin equal to the server's own (on top of SameSite). A missing Origin
//    is refused unless `allowMissing` (non-browser tools).
//  - sanitiseName: display names are cleaned like player directives (turn.js sanitiseDirective), 1-20 characters.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sanitiseDirective } from '../turn.js';
import { isId, newId } from './ids.js';

export const HOST_COOKIE = 'jd_host';
export const NAME_MAX = 20;
export const participantCookieName = (gameId) => `jd_par_${gameId}`;

// ---------- cookies ----------
export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

export function serializeCookie(name, value, { path = '/', maxAgeS, httpOnly = true, sameSite = 'Strict', secure = false } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('bad cookie name');
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (maxAgeS !== undefined) bits.push(`Max-Age=${Math.floor(maxAgeS)}`);
  return bits.join('; ');
}

export const clearCookie = (name, path) => serializeCookie(name, '', { path, maxAgeS: 0 });

// ---------- constant-time compare ----------
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

// ---------- participants ----------
export const newParticipantToken = () => newId('par_');

// Set-Cookie lines for a joined seat: one for the API path, one for the play page.
export function participantCookies(gameId, token, { pagePath = `/games/${gameId}`, maxAgeS = 7 * 24 * 3600 } = {}) {
  const name = participantCookieName(gameId);
  return [
    serializeCookie(name, token, { path: `/v1/games/${gameId}`, maxAgeS }),
    serializeCookie(name, token, { path: pagePath, maxAgeS }),
  ];
}

// The token a request presents for this game, or null when absent/malformed. The caller looks it up in the game.
export function participantToken(req, gameId) {
  const t = parseCookies(req.headers?.cookie)[participantCookieName(gameId)];
  return isId('par_', t) ? t : null;
}

// ---------- loopback / origin ----------
export function isLoopback(req) {
  const a = req.socket?.remoteAddress ?? req.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

export function checkOrigin(req, ownOrigin, { allowMissing = false } = {}) {
  const origin = req.headers?.origin;
  if (origin === undefined) return allowMissing;
  const own = Array.isArray(ownOrigin) ? ownOrigin : [ownOrigin];
  return own.includes(origin);
}

// ---------- names ----------
// -> { name } or { error }.
export function sanitiseName(name) {
  if (typeof name !== 'string') return { error: 'name must be a string' };
  const clean = sanitiseDirective(name);
  if (clean.length < 1) return { error: 'name must not be empty' };
  if ([...clean].length > NAME_MAX) return { error: `name must be at most ${NAME_MAX} characters` };
  return { name: clean };
}

// ---------- host ----------
export class HostAuth {
  #token;
  #sessions = new Set();
  #remote;

  // hostRemote: boolean or () => boolean; default reads HOST_REMOTE=1 at each call.
  constructor({ token, hostRemote = () => process.env.HOST_REMOTE === '1' } = {}) {
    if (!token) throw new Error('HostAuth needs the host token');
    this.#token = token;
    this.#remote = typeof hostRemote === 'function' ? hostRemote : () => hostRemote;
  }

  // Swaps the URL-fragment token for a session id; null if wrong. Loopback rule applies here too.
  exchange(presented, req) {
    if (!this.#remoteOk(req)) return null;
    if (!safeEqual(String(presented ?? ''), this.#token)) return null;
    const id = randomBytes(24).toString('base64url');
    this.#sessions.add(id);
    return id;
  }

  sessionCookie(id, { maxAgeS = 12 * 3600 } = {}) {
    return serializeCookie(HOST_COOKIE, id, { path: '/', maxAgeS });
  }

  #remoteOk(req) {
    return isLoopback(req) || this.#remote();
  }

  #hasSession(req) {
    const id = parseCookies(req.headers?.cookie)[HOST_COOKIE];
    if (!id) return false;
    let ok = false;
    for (const s of this.#sessions) if (safeEqual(id, s)) ok = true; // no early exit
    return ok;
  }

  // -> { ok: true } or { ok: false, status: 403, error }. Players and anyone else get the same 403.
  requireHost(req) {
    if (!this.#hasSession(req) || !this.#remoteOk(req)) return { ok: false, status: 403, error: 'Forbidden.' };
    return { ok: true };
  }

  revoke(req) {
    const id = parseCookies(req.headers?.cookie)[HOST_COOKIE];
    if (id) this.#sessions.delete(id);
  }
}
