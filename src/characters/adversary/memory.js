// One adversary's memory: the only state its Jev brain sees between steps (besides the
// situation facts). Mirrors the explorer's memory shape:
//
//   id             - which adversary this is
//   objective      - "Catch the explorer before it finds the treasure"
//   brain          - on/off, since which tick, and why it last switched
//   approach       - how it is hunting now (null id while the brain is off), plus approaches dropped
//   findings       - notable facts (spotted the explorer, lost sight, gave up)
//   progress       - ticks_hunting, ticks_since_seen, distance_trend
//   latest_action  - Jev's last next_move answer, verbatim (or the forced/fallback move)
//
// All memories are written together to dungeon-game/adversaries.json each tick (turn.js).
// FOG: nothing here may hold the explorer's position except as it was when seen.
// Zero dependencies: hand-written validation.
import { writeFile } from 'node:fs/promises';

export const LIMITS = { objective: 200, approach: 240, triedApproaches: 5, findings: 10, fact: 200, reason: 200, trend: 160 };
export const OBJECTIVE = 'Catch the explorer before it finds the treasure.';
const OFF_TEXT = 'Brain off: patrolling the dungeon by code.';

export function createMemory(id) {
  return {
    id,
    objective: OBJECTIVE,
    brain: { on: false, since_tick: 0, last_reason: null },
    approach: { id: null, current: OFF_TEXT, since_step: 0, tried: [] },
    findings: [],
    progress: { ticks_hunting: 0, ticks_since_seen: 0, distance_trend: 'not hunting' },
    latest_action: null,
  };
}

export function addFinding(memory, fact, tick) {
  const text = String(fact).trim().slice(0, LIMITS.fact);
  if (!text || memory.findings.some((f) => f.fact === text)) return;
  memory.findings.push({ fact: text, tick });
  while (memory.findings.length > LIMITS.findings) memory.findings.shift();
}

// Drops the current approach (into `tried`, unless it was the brain-off placeholder) and starts `id`.
export function setApproach(memory, { id, text }, reason, tick) {
  const a = memory.approach;
  if (a.id === id) return;
  if (a.id) {
    a.tried.push({ id: a.id, approach: a.current, steps: `${a.since_step}–${tick}`, reason: String(reason).slice(0, LIMITS.approach) });
    a.tried = a.tried.slice(-LIMITS.triedApproaches);
  }
  a.id = id;
  a.current = text.slice(0, LIMITS.approach);
  a.since_step = tick;
}

export function brainOn(memory, tick, reason) {
  memory.brain = { on: true, since_tick: tick, last_reason: String(reason).slice(0, LIMITS.reason) };
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
    ? { choice: decision.choice, confidence: decision.confidence, probabilities: decision.probabilities, forced: false, fallback: false }
    : { choice: dir, confidence: null, probabilities: null, forced: Boolean(forced), fallback: Boolean(fallback) };
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
    if (!t || !isStr(t.id, 64) || !isStr(t.approach, LIMITS.approach) || typeof t.steps !== 'string' || !isStr(t.reason, LIMITS.approach)) fail(`approach.tried[${i}]`);
  });
  if (!Array.isArray(m.findings) || m.findings.length > LIMITS.findings) fail('findings');
  m.findings.forEach((f, i) => {
    if (!f || !isStr(f.fact, LIMITS.fact) || !isNum(f.tick)) fail(`findings[${i}]`);
  });
  const p = m.progress;
  if (!p || !Number.isInteger(p.ticks_hunting) || !Number.isInteger(p.ticks_since_seen) || !isStr(p.distance_trend, LIMITS.trend)) fail('progress');
  const l = m.latest_action;
  if (l !== null) {
    if (typeof l !== 'object' || typeof l.choice !== 'string' || typeof l.forced !== 'boolean' || typeof l.fallback !== 'boolean') fail('latest_action');
    if (l.confidence !== null && !isNum(l.confidence)) fail('latest_action.confidence');
    if (l.probabilities !== null && typeof l.probabilities !== 'object') fail('latest_action.probabilities');
  }
  return m;
}

// Validates every memory, then writes them all to dirURL/adversaries.json.
export async function saveMemories(memories, tick, dirURL) {
  memories.forEach(validateMemory);
  await writeFile(new URL('adversaries.json', dirURL), JSON.stringify({ tick, adversaries: memories }, null, 2));
}
