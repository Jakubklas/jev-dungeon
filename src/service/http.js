// Tiny HTTP plumbing for the hosted service: a pattern router, a size-limited JSON body reader, `send`, and an SSE helper.
//  - Router: add(method, '/v1/games/:id/join', handler); match(method, path) -> { handler, params } | { status: 404|405, allow }.
//  - readJson(req, { limit }) throws HttpError (413 too large, 400 not JSON / not an object).
//  - openSse(req, res, opts): headers, `lastEventId` from the Last-Event-ID header (or ?lastEventId), `send({ id, event, data })`,
//    `: heartbeat` comments every heartbeatMs, and the client is closed when more than maxQueuedBytes wait unwritten.
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const compile = (pattern) => {
  const names = [];
  const re = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z_]+)/g, (_, n) => { names.push(n); return '([^/]+)'; });
  return { re: new RegExp(`^${re}/?$`), names };
};

export class Router {
  #routes = [];
  add(method, pattern, handler) {
    this.#routes.push({ method: method.toUpperCase(), ...compile(pattern), handler });
    return this;
  }

  match(method, path) {
    const allow = new Set();
    for (const r of this.#routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method.toUpperCase()) { allow.add(r.method); continue; }
      const params = {};
      r.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = m[i + 1]; } });
      return { handler: r.handler, params };
    }
    return allow.size ? { status: 405, allow: [...allow] } : { status: 404 };
  }
}

export function readJson(req, { limit = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    req.on('data', (c) => {
      if (done) return; // over the limit already: keep draining so the 413 can be sent on the same connection
      n += c.length;
      if (n > limit) { fail(new HttpError(413, `Body is larger than ${limit} bytes.`)); chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('error', fail);
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'Body must be a JSON object.'));
        resolve(v);
      } catch {
        reject(new HttpError(400, 'Body is not valid JSON.'));
      }
    });
  });
}

// headers: extra response headers (Set-Cookie may be an array).
export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

const oneLine = (s) => String(s).replace(/[\r\n]/g, ' ');

export function openSse(req, res, { lastEventId, heartbeatMs = 15000, maxQueuedBytes = 1024 * 1024, onClose } = {}) {
  const header = req.headers?.['last-event-id'];
  const last = lastEventId ?? (header !== undefined ? String(header) : null);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': open\n\n');
  let closed = false;
  let reason = null;
  let blockedAt = null;
  let lagMs = 0;
  res.on?.('drain', () => { if (blockedAt !== null) lagMs = Math.max(lagMs, Date.now() - blockedAt); blockedAt = null; });
  const close = (why = 'closed') => {
    if (closed) return;
    closed = true;
    reason = why;
    clearInterval(timer);
    try { res.end(); } catch { /* socket gone */ }
    onClose?.(why);
  };
  const write = (text) => {
    if (closed) return false;
    if (res.writableLength + Buffer.byteLength(text) > maxQueuedBytes) { close('overflow'); return false; }
    if (!res.write(text) && blockedAt === null) blockedAt = Date.now();
    return true;
  };
  const timer = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
  timer.unref?.();
  req.on?.('close', () => close('client'));
  res.on?.('close', () => close('client'));
  return {
    lastEventId: last,
    get closed() { return closed; },
    get reason() { return reason; },
    get lagMs() { return Math.max(lagMs, blockedAt === null ? 0 : Date.now() - blockedAt); },
    send({ id, event, data }) {
      let frame = '';
      if (id !== undefined) frame += `id: ${oneLine(id)}\n`;
      if (event) frame += `event: ${oneLine(event)}\n`;
      frame += `data: ${JSON.stringify(data ?? null)}\n\n`;
      return write(frame);
    },
    close,
  };
}
