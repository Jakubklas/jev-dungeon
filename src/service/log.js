// Structured JSON-lines logger for the hosted service. Keys, tokens, cookies and bodies must never reach a log, so any
// field whose name looks like one is dropped (at any depth) and its name is listed under `redacted`. Output goes to an
// injected `write(line)` (default stdout), the clock is injectable for checks.
const SECRET_NAME = /(^|_|-)(key|keys|token|tokens|authorization|auth|cookie|cookies|body|bodies|secret|password)($|_|-)|apikey/i;

export const isSecretName = (name) => SECRET_NAME.test(String(name).replace(/([a-z])([A-Z])/g, '$1_$2'));

function strip(value, path, redacted, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => strip(v, path, redacted, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const p = path ? `${path}.${k}` : k;
    if (isSecretName(k)) { redacted.push(p); continue; }
    out[k] = strip(v, p, redacted, depth + 1);
  }
  return out;
}

export function createLogger({ write = (line) => process.stdout.write(line + '\n'), now = () => Date.now(), base = {} } = {}) {
  const emit = (level, msg, fields = {}) => {
    const redacted = [];
    const clean = strip({ ...base, ...fields }, '', redacted);
    const entry = { t: new Date(now()).toISOString(), level, msg: String(msg), ...clean };
    if (redacted.length) entry.redacted = redacted;
    write(JSON.stringify(entry));
  };
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (more) => createLogger({ write, now, base: { ...base, ...more } }),
  };
}
