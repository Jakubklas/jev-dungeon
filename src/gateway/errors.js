// The ways a paid Jev call can end badly. The runtime tells them apart: a rejected key stops one explorer (or pauses
// the game, for the server key), a timeout or an abort costs one decision, anything else is a final failure.

// Jev answered 401 or 403: the key is wrong. Never retried.
export class KeyRejected extends Error {
  constructor(status) {
    super(`Jev rejected the key (${status})`);
    this.name = 'KeyRejected';
    this.status = status;
  }
}

// The caller has no key to use. There is deliberately no fallback to another key.
export class NoKey extends KeyRejected {
  constructor(who = 'actor') {
    super(null);
    this.message = `No Jev key for ${who}`;
    this.name = 'NoKey';
  }
}

// The deadline for the whole call (retries and backoff included) passed.
export class CallTimeout extends Error {
  constructor(ms) {
    super(`Jev call timed out after ${ms} ms`);
    this.name = 'CallTimeout';
    this.ms = ms;
  }
}

// The caller's own signal fired (pause, forfeit, new game). One class for the whole program: see ../call-aborted.js.
export { CallAborted } from '../call-aborted.js';

// A final failure: a status that is not retried, retries used up, a network error or an unreadable 200.
// `status` is 0 when nothing came back.
export class CallFailed extends Error {
  constructor(status, bodySnippet = '', name = 'Jev API') {
    super(status ? `${name} ${status}: ${bodySnippet}` : `Couldn't reach ${name}: ${bodySnippet}`);
    this.name = 'CallFailed';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}
