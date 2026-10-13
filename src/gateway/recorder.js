// Where the gateway writes one entry per HTTP post, for diagnosis: never the key, never a request or response body.
// An entry is recorded before the fetch (outcome 'pending', so a crash leaves a trace) and completed after it.
// The interface is `record(entry) -> handle` and `update(handle, patch)`; the file store (calls.jsonl) implements it
// later. `MemoryRecorder` keeps the entries in an array, for the checks.

const FIELDS = ['at', 'game', 'actor', 'kind', 'attempt', 'status', 'bytes_out', 'bytes_in', 'ms', 'outcome'];

// Copies only the known fields, so nothing else (a key, a body) can ride along by accident.
export function cleanEntry(entry) {
  const out = {};
  for (const f of FIELDS) if (entry[f] !== undefined) out[f] = entry[f];
  return out;
}

export class MemoryRecorder {
  entries = [];
  record(entry) {
    const e = cleanEntry(entry);
    this.entries.push(e);
    return e;
  }
  update(handle, patch) {
    Object.assign(handle, cleanEntry(patch));
  }
}

// Discards everything (the default when nobody listens).
export class NullRecorder {
  record() { return null; }
  update() {}
}
