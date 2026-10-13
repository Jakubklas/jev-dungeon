// Tabu lists (PLAN-tabu.md): an option a character kept repeating without gain is taken off its menu for a while, so
// Jev never sees it and has to pick something else. Pure: imports nothing, holds no state of its own, no clock and no
// rng (an option is ruled out by what the character did, never by chance). Both characters use it: the caller owns
// the plain object createTabu() returns and keeps it private (never in memory.json, never sent to Jev).
//
// Levels are plain strings ('tactic', 'mood', 'move', 'approach'); attributes are option ids or cell keys.
// An entry lasts `tenure` steps, or (encounter: true) until endEncounter().

export const createTabu = () => ({ entries: [], strikes: {} });

const same = (e, level, attr) => e.level === level && e.attr === attr;
const strikeKey = (level, attr) => `${level}:${attr}`;

// Drops the entries whose tenure ran out (until <= step). Encounter entries have until = Infinity.
export function age(tabu, step) {
  tabu.entries = tabu.entries.filter((e) => e.until > step);
  return tabu;
}

// Rules `attr` out at `level` from `step`. Returns true when the entry is new (the caller logs one event), false when
// it only extended a live one (the later end wins).
export function add(tabu, level, attr, { step, tenure = 0, encounter = false, reason = '' }) {
  const until = encounter ? Infinity : step + tenure;
  const live = tabu.entries.find((e) => same(e, level, attr) && e.until > step);
  if (live) {
    live.until = Math.max(live.until, until);
    live.encounter = live.encounter || encounter;
    return false;
  }
  tabu.entries = [...tabu.entries.filter((e) => !same(e, level, attr)), { level, attr, since: step, until, encounter, reason }];
  return true;
}

export const isTabu = (tabu, level, attr, step) => tabu.entries.some((e) => same(e, level, attr) && e.until > step);

// The live entry for `attr` at `level` ({ level, attr, since, until, encounter, reason }), or null.
export const entryOf = (tabu, level, attr, step) => tabu.entries.find((e) => same(e, level, attr) && e.until > step) ?? null;

// The live attributes at `level`, oldest first.
export const active = (tabu, level, step) => tabu.entries.filter((e) => e.level === level && e.until > step).map((e) => e.attr);

// "It failed again without gain": bumps and returns the counter toward a rule's threshold.
export function strike(tabu, level, attr) {
  const k = strikeKey(level, attr);
  tabu.strikes = { ...tabu.strikes, [k]: (tabu.strikes[k] ?? 0) + 1 };
  return tabu.strikes[k];
}

export const strikes = (tabu, level, attr) => tabu.strikes[strikeKey(level, attr)] ?? 0;

// Progress resets the counters: one attribute, or every attribute at `level`.
export function clearStrikes(tabu, level, attr = null) {
  const drop = attr === null ? (k) => k.startsWith(`${level}:`) : (k) => k === strikeKey(level, attr);
  tabu.strikes = Object.fromEntries(Object.entries(tabu.strikes).filter(([k]) => !drop(k)));
  return tabu;
}

// The encounter is over: its entries and every strike counter go.
export function endEncounter(tabu) {
  tabu.entries = tabu.entries.filter((e) => !e.encounter);
  tabu.strikes = {};
  return tabu;
}

// The menu to send: `ids` minus the live tabu entries at `level`, order kept. Aspiration first: ids in `keep` are never
// removed, and the menu never drops below `min` ids. If it would, the removed ids with the least tenure left are put
// back first (encounter entries last), ties in `ids` order, so the result is deterministic.
// -> { allowed, removed, lifted }
export function filterOptions(ids, tabu, level, step, { keep = [], min = 1 } = {}) {
  const until = new Map(tabu.entries.filter((e) => e.level === level && e.until > step).map((e) => [e.attr, e.until]));
  const out = new Set(ids.filter((id) => until.has(id) && !keep.includes(id)));
  const lifted = [];
  const back = [...out].sort((a, b) => until.get(a) - until.get(b) || ids.indexOf(a) - ids.indexOf(b));
  while (ids.length - out.size < Math.min(min, ids.length) && back.length) {
    const id = back.shift();
    out.delete(id);
    lifted.push(id);
  }
  return { allowed: ids.filter((id) => !out.has(id)), removed: ids.filter((id) => out.has(id)), lifted };
}

// For the turn report and the UI, never for Jev: { level: [{ attr, steps_left | 'encounter', reason }] }.
export function snapshot(tabu, step) {
  const out = {};
  for (const e of tabu.entries) {
    if (e.until <= step) continue;
    (out[e.level] ??= []).push({ attr: e.attr, steps_left: e.encounter ? 'encounter' : e.until - step, reason: e.reason });
  }
  return out;
}
