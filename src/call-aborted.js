// The one CallAborted class: the caller's own signal fired (pause, forfeit, new game) before or during a Jev call. It
// lives outside src/gateway/ so the character modules may import it (they must never reference the gateway), and the
// gateway re-exports it from errors.js.
export class CallAborted extends Error {
  constructor() {
    super('Jev call aborted');
    this.name = 'CallAborted';
  }
}
