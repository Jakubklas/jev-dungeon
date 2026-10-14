// Random prefixed ids for the hosted service: `gm_` (games) and `par_` (participants). 128 bits from the OS, url-safe,
// so an id doubles as an unguessable capability when it must (a participant token). Ghost ids stay game-local a1..aN.
import { randomBytes } from 'node:crypto';

export const PREFIXES = ['gm_', 'par_'];

export function newId(prefix) {
  if (!PREFIXES.includes(prefix)) throw new Error(`newId: unknown prefix ${JSON.stringify(prefix)}`);
  return prefix + randomBytes(16).toString('base64url');
}

// True for something newId could have produced (used before an id becomes a file name or a cookie name).
export const isId = (prefix, s) => typeof s === 'string' && s.startsWith(prefix) && /^[A-Za-z0-9_-]{22}$/.test(s.slice(prefix.length));
