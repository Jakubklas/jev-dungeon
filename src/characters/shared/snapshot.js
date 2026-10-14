// JSON-safe encoding for private decision state. Preserve insertion order and non-finite sentinels;
// JSON.stringify alone turns Infinity into null and discards Set/Map contents.
export function encodeSnapshot(value) {
  if (value === undefined) return { $snapshot: 'undefined' };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $snapshot: 'number', value: String(value) };
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Set) return { $snapshot: 'set', values: [...value].map(encodeSnapshot) };
  if (value instanceof Map) return { $snapshot: 'map', entries: [...value].map(([k, v]) => [encodeSnapshot(k), encodeSnapshot(v)]) };
  if (Array.isArray(value)) return value.map(encodeSnapshot);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeSnapshot(v)]));
}

export function decodeSnapshot(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeSnapshot);
  if (value.$snapshot === 'undefined') return undefined;
  if (value.$snapshot === 'number') return Number(value.value);
  if (value.$snapshot === 'set') return new Set(value.values.map(decodeSnapshot));
  if (value.$snapshot === 'map') return new Map(value.entries.map(([k, v]) => [decodeSnapshot(k), decodeSnapshot(v)]));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeSnapshot(v)]));
}
