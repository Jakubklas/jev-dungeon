// One adversary's memory: the only state its Jev brain sees between steps (besides the
// situation facts). Mirrors the explorer's memory shape:
//
//   id             - which adversary this is
//   objective      - "Catch the explorer before it finds the treasure"
//   brain          - on/off, since which tick, and why it last switched
//   approach       - how it is hunting now (null id while the brain is off), plus approaches dropped
//   tally          - counters for this hunt: sightings, lost_sight, hits, alerts_heard
//   events         - at most 5 notable moments { tick, text } (first sighting, a hit, called for help,
//                    gave up); the tick is never repeated inside the text
//   progress       - ticks_hunting, ticks_since_seen, distance_trend
//   latest_action  - Jev's last next_move answer: choice, confidence, forced, fallback (no
//                    probabilities: the UI reads those from the private hunt state, see brain.js)
//
// All memories are written together to dungeon-game/adversaries.json each tick (turn.js).
// FOG: nothing here may hold the explorer's position except as it was when seen.
// Zero dependencies: hand-written validation.
import { writeFile } from 'node:fs/promises';

export const LIMITS = { objective: 200, approach: 240, triedApproaches: 5, events: 5, event: 200, reason: 200, trend: 160 };
export const OBJECTIVE = 'Catch the explorer before it finds the treasure.';
const OFF_TEXT = 'Brain off: patrolling the dungeon by code.';
const SEARCH_IDS = ['cut_off', 'sweep_last_seen']; // the only approaches whose outcome goes into `tried`
export const TALLY_KEYS = ['sightings', 'lost_sight', 'hits', 'alerts_heard'];
const newTally = () => ({ sightings: 0, lost_sight: 0, hits: 0, alerts_heard: 0 });

export function createMemory(id) {
  return {
    id,
    objective: OBJECTIVE,
    brain: { on: false, since_tick: 0, last_reason: null },
    approach: { id: null, current: OFF_TEXT, since_step: 0, tried: [] },
    tally: newTally(),
    events: [],
    progress: { ticks_hunting: 0, ticks_since_seen: 0, distance_trend: 'not hunting' },
    latest_action: null,
  };
}

// A notable moment (at most LIMITS.events kept, oldest dropped; an identical repeat is ignored).
export function addEvent(memory, text, tick) {
  const t = String(text).trim().slice(0, LIMITS.event);
  if (!t || memory.events.at(-1)?.text === t) return;
  memory.events.push({ tick, text: t });
  while (memory.events.length > LIMITS.events) memory.events.shift();
}

export function count(memory, key) {
  memory.tally[key] += 1;
  return memory.tally[key];
}

// Drops the current approach and starts `id`. Only the outcome of a search approach is kept in
// `tried` (when it is replaced by another search approach or by giving up), not the hops between
// direct_pursuit and searching, and not an approach dropped the tick it was set.
export function setApproach(memory, { id, text }, reason, tick) {
  const a = memory.approach;
  if (a.id === id) return;
  if (SEARCH_IDS.includes(a.id) && id !== 'direct_pursuit' && tick > a.since_step) {
    a.tried.push({ id: a.id, steps: `${a.since_step}–${tick}`, reason: String(reason).slice(0, LIMITS.approach) });
    a.tried = a.tried.slice(-LIMITS.triedApproaches);
  }
  a.id = id;
  a.current = text.slice(0, LIMITS.approach);
  a.since_step = tick;
}

export function brainOn(memory, tick, reason) {
  memory.brain = { on: true, since_tick: tick, last_reason: String(reason).slice(0, LIMITS.reason) };
  memory.tally = newTally(); // counters and events describe the current hunt
  memory.events = [];
  memory.progress.ticks_hunting = 0;
  memory.progress.ticks_since_seen = 0;
}

export function brainOff(memory, tick, reason) {
  memory.brain = { on: false, since_tick: tick, last_reason: String(reason).slice(0, LIMITS.reason) };
  setApproach(memory, { id: null, text: OFF_TEXT }, reason, tick);
  memory.progress.distance_trend = 'not hunting';
}

export function recordAction(memory, { dir, decision, forced, fallback }) {
  memory.latest_action = decision
    ? { choice: decision.choice, confidence: decision.confidence, forced: false, fallback: false }
    : { choice: dir, confidence: null, forced: Boolean(forced), fallback: Boolean(fallback) };
}

// A memory that breaks the schema is a bug: fail loudly.
export function validateMemory(m) {
  const fail = (msg) => {
    throw new Error(`Invalid adversary memory${m?.id ? ` (${m.id})` : ''}: ${msg}`);
  };
  const isStr = (v, max) => typeof v === 'string' && v.length <= max;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!m || typeof m !== 'object') fail('not an object');
  if (!isStr(m.id, 16)) fail('id');
  if (!isStr(m.objective, LIMITS.objective)) fail('objective');
  const b = m.brain;
  if (!b || typeof b.on !== 'boolean' || !isNum(b.since_tick) || (b.last_reason !== null && !isStr(b.last_reason, LIMITS.reason))) fail('brain');
  const a = m.approach;
  if (!a || typeof a !== 'object') fail('approach');
  if (a.id !== null && !isStr(a.id, 64)) fail('approach.id');
  if ((a.id === null) === b.on) fail('approach.id must be set exactly while the brain is on');
  if (!isStr(a.current, LIMITS.approach)) fail('approach.current');
  if (!isNum(a.since_step)) fail('approach.since_step');
  if (!Array.isArray(a.tried) || a.tried.length > LIMITS.triedApproaches) fail('approach.tried');
  a.tried.forEach((t, i) => {
    if (!t || !isStr(t.id, 64) || !SEARCH_IDS.includes(t.id) || typeof t.steps !== 'string' || !isStr(t.reason, LIMITS.approach)) fail(`approach.tried[${i}]`);
  });
  const ty = m.tally;
  if (!ty || typeof ty !== 'object' || Object.keys(ty).join() !== TALLY_KEYS.join() || !TALLY_KEYS.every((k) => Number.isInteger(ty[k]) && ty[k] >= 0)) fail('tally');
  if (!Array.isArray(m.events) || m.events.length > LIMITS.events) fail('events');
  m.events.forEach((e, i) => {
    if (!e || !isStr(e.text, LIMITS.event) || !isNum(e.tick) || Object.keys(e).length !== 2) fail(`events[${i}]`);
    if (e.text.includes(`tick ${e.tick}`)) fail(`events[${i}] repeats its tick in the text`);
  });
  const p = m.progress;
  if (!p || !Number.isInteger(p.ticks_hunting) || !Number.isInteger(p.ticks_since_seen) || !isStr(p.distance_trend, LIMITS.trend)) fail('progress');
  const l = m.latest_action;
  if (l !== null) {
    if (typeof l !== 'object' || typeof l.choice !== 'string' || typeof l.forced !== 'boolean' || typeof l.fallback !== 'boolean') fail('latest_action');
    if (l.confidence !== null && !isNum(l.confidence)) fail('latest_action.confidence');
    if ('probabilities' in l) fail('latest_action.probabilities (kept in the hunt state, not in memory)');
  }
  return m;
}

// Validates every memory, then writes them all to dirURL/adversaries.json.
export async function saveMemories(memories, tick, dirURL) {
  memories.forEach(validateMemory);
  await writeFile(new URL('adversaries.json', dirURL), JSON.stringify({ tick, adversaries: memories }, null, 2));
}
