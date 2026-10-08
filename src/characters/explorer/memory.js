// The explorer's memory: the persistent part of what Jev reads between steps. Jev's `state` is
// built from this plus perception's per-tick facts (brain.js), never sent verbatim.
//
// memory.json is the source of truth (structured, validated, size-capped); memory.md is a
// readable rendering for people, nothing reads it back.
//
//   approach          - how it is currently exploring, plus approaches tried and dropped
//                       (Jev reviews it every few steps)
//   progress          - counters the approach review is judged from, plus the coins carried
//   sentiment         - the mind Jev picked at the latest approach decision ({ id, since_step }); its code profile changes behaviour (see brain.js)
//   sentiment_history - the last few picks, [{ id, step }]
//   recent            - the last 6 moves and 8 positions (a ping-pong shows as back_and_forth)
//   encounters        - counters: { count, escaped, hits, dispelled, last_at_step }
//   events            - up to 6 short milestones [{ step, text }] (portal seen, hit, switch, win)
//   skills            - a plain-JSON mirror of the skill set, up to 4: [{ id, kind, name, text, ready, cooldown_left }]
//                       (brain.js rewrites it every turn from the live skills; Jev's state carries id -> readiness only)
//   directive         - the player's live instruction { text, from_step, until_step } or null (PLAN-inject)
//   landmarks         - up to 8 typed, located facts [{ kind, cell, step, note }]; the portal is
//                       pinned, the oldest of the rest is evicted. Perception turns them into
//                       relative direction/distance each tick.
//
// `approach.thought` is a short first-person line for the current approach (the UI's thought
// bubble). An encounter tactic (slip_past, run_away, ...) is not a verdict on the approach it
// interrupted: that approach is parked in `approach.interrupted` (never in `tried`) and restored
// once the encounter is over. Tactics themselves never go into `tried` either.
//
// Zero dependencies: hand-written validation instead of zod.
import { writeFile } from 'node:fs/promises';
import { addLandmarkTo, backAndForth, pushRing } from '../shared/memory-kit.js';
import { band } from './confidence.js';

export const LIMITS = {
  approach: 240,
  triedApproaches: 5,
  thought: 60,
  sentimentHistory: 5,
  events: 6, // oldest dropped first
  eventText: 200,
  landmarks: 8, // the portal is never evicted
  landmarkNote: 120,
  recentMoves: 6,
  skills: 4,
  skillText: 120,
  directive: 140, // the player's instruction (PLAN-inject)
  confidenceCount: 1e6, // each confidence counter (progress.confidence, toggle on only)
  recentCells: 8, // 6 moves plus the two positions before them, so every move can be judged
};

export const LANDMARK_KINDS = ['exit', 'dead_end_explored', 'hit_here', 'hiding_spot_used'];

const WINDOW = 10; // revisits_last_10
// The rolling window of revisit flags lives outside the memory object, so it never
// reaches JSON.stringify (Jev's state, memory.json, the browser).
const revisitWindows = new WeakMap();

// The mood ids (brain.js SENTIMENTS has exactly these keys; check-dungeon asserts it). Validation accepts nothing else.
export const MOOD_IDS = ['panic', 'wary', 'guarded', 'cautious', 'steady', 'greedy', 'bold', 'fearless'];

export function createMemory({ approachId, approachText, thought, sentiment, start }) {
  const memory = {
    approach: {
      id: approachId, current: approachText.slice(0, LIMITS.approach), thought: thought.slice(0, LIMITS.thought), since_step: 1, tried: [], interrupted: null,
    },
    progress: { steps: 0, known_floor_cells: 0, revealed_since_approach: 0, steps_since_approach: 0, revisits_last_10: 0, coins: 0 },
    sentiment: { id: sentiment.id, since_step: 0 },
    sentiment_history: [],
    recent: { moves: [], cells: [[...start]], back_and_forth: 0 },
    encounters: { count: 0, escaped: 0, hits: 0, dispelled: 0, last_at_step: 0 },
    events: [],
    skills: [],
    landmarks: [],
    directive: null, // { text, from_step, until_step } while the player's instruction is live
  };
  revisitWindows.set(memory, []);
  return memory;
}

export { backAndForth };

// Called once per step, after the move was applied. `pos` is where the explorer stands now.
export function recordStep(memory, { step, dir, pos, revealed, revisit, known_floor_cells, coins = memory.progress.coins }) {
  const p = memory.progress;
  p.steps = step;
  p.known_floor_cells = known_floor_cells;
  p.coins = coins;
  p.revealed_since_approach += revealed;
  p.steps_since_approach += 1;
  const window = revisitWindows.get(memory) ?? [];
  window.push(Boolean(revisit));
  if (window.length > WINDOW) window.shift();
  revisitWindows.set(memory, window);
  p.revisits_last_10 = window.filter(Boolean).length;
  const r = memory.recent;
  r.moves = pushRing(r.moves, dir, LIMITS.recentMoves);
  r.cells = pushRing(r.cells, [...pos], LIMITS.recentCells);
  r.back_and_forth = backAndForth(r.cells, LIMITS.recentMoves);
}

// Appends a short milestone and keeps the newest LIMITS.events. The step is its own field: never
// repeat it inside `text`.
export function addEvent(memory, step, text) {
  const t = String(text).trim().slice(0, LIMITS.eventText);
  if (!t) return;
  memory.events.push({ step, text: t });
  memory.events = memory.events.slice(-LIMITS.events);
}

// encounters counters: 'count' (a new encounter began), 'escaped' (it ended unhurt), 'hits' or 'dispelled'.
export function countEncounter(memory, field, step) {
  memory.encounters[field] += 1;
  memory.encounters.last_at_step = step;
}

// Mirrors the live skill summaries ({ id, kind, name, text, ready, cooldown_left }) into memory.
export function setSkills(memory, summaries) {
  memory.skills = (summaries ?? []).slice(0, LIMITS.skills).map((k) => ({
    id: k.id, kind: k.kind, name: k.name, text: String(k.text ?? '').slice(0, LIMITS.skillText), ready: Boolean(k.ready), cooldown_left: k.cooldown_left,
  }));
}

// Adds a located fact. One entry per kind + cell (a repeat refreshes its step and note and makes
// it the newest). Over the limit the oldest non-exit landmark goes.
export function addLandmark(memory, { kind, cell, step, note }) {
  memory.landmarks = addLandmarkTo(memory.landmarks, { kind, cell, step, note }, { max: LIMITS.landmarks, noteMax: LIMITS.landmarkNote, pinnedKind: 'exit' });
}

// Drops the current approach (with why) and starts a new one from the next step.
// Never call it with a tactic as the current approach: tactics are parked/replaced, not "tried".
export function switchApproach(memory, { id, text, thought }, reason, step) {
  const a = memory.approach;
  a.tried.push({ id: a.id, approach: a.current, steps: `${a.since_step}–${step}`, reason: String(reason).slice(0, LIMITS.approach) });
  a.tried = a.tried.slice(-LIMITS.triedApproaches);
  startApproach(memory, id, text, thought, step);
}

// Switches to `id` with no `tried` row: the current approach did not fail (a coin detour starts or ends).
export function changeApproach(memory, { id, text, thought }, step) {
  startApproach(memory, id, text, thought, step);
}

// Parks the current approach (no `tried` row: it did not fail) and starts `id` from the next step.
// If an approach is already parked, it stays parked.
export function interruptApproach(memory, { id, text, thought }, reason, step) {
  const a = memory.approach;
  if (!a.interrupted) {
    a.interrupted = { id: a.id, approach: a.current, since_step: a.since_step, reason: String(reason).slice(0, LIMITS.approach) };
  }
  startApproach(memory, id, text, thought, step);
}

// Restores the parked approach (fresh counters, so a review doesn't judge it by the chase).
// Returns its id, or null when nothing was parked. `thoughtOf(id)` gives the approach's thought line.
export function resumeApproach(memory, step, thoughtOf) {
  const parked = memory.approach.interrupted;
  if (!parked) return null;
  memory.approach.interrupted = null;
  startApproach(memory, parked.id, parked.approach, thoughtOf(parked.id), step);
  return parked.id;
}

// Replaces the parked approach, e.g. the portal was spotted mid-chase: after the chase the explorer
// should head for the portal, not resume exploring. The dropped one is replaced, not failed: no `tried` row.
export function replaceInterrupted(memory, { id, text }, reason, step) {
  const a = memory.approach;
  const old = a.interrupted; // replaced, not failed: no `tried` row
  a.interrupted = { id, approach: text.slice(0, LIMITS.approach), since_step: step + 1, reason: old?.reason ?? String(reason).slice(0, LIMITS.approach) };
}

function startApproach(memory, id, text, thought, step) {
  const a = memory.approach;
  a.id = id;
  a.current = text.slice(0, LIMITS.approach);
  a.thought = String(thought ?? '').slice(0, LIMITS.thought);
  a.since_step = step + 1;
  memory.progress.revealed_since_approach = 0;
  memory.progress.steps_since_approach = 0;
}

// Records the sentiment picked at a decision step. since_step moves only when the mood changes;
// every pick goes into the history.
export function setSentiment(memory, { id }, step) {
  const s = memory.sentiment;
  if (s.id !== id) {
    s.id = id;
    s.since_step = step;
  }
  memory.sentiment_history.push({ id, step });
  memory.sentiment_history = memory.sentiment_history.slice(-LIMITS.sentimentHistory);
}

// A memory that breaks the schema is a bug: fail loudly.
export function validateMemory(m) {
  const fail = (msg) => {
    throw new Error(`Invalid memory: ${msg}`);
  };
  const isStr = (v, max) => typeof v === 'string' && v.length <= max;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isCell = (c) => Array.isArray(c) && c.length === 2 && c.every(Number.isInteger);
  if (!m || typeof m !== 'object') fail('not an object');
  const a = m.approach;
  if (!a || typeof a !== 'object') fail('approach');
  if (!isStr(a.id, 64)) fail('approach.id');
  if (!isStr(a.current, LIMITS.approach)) fail('approach.current');
  if (!isStr(a.thought, LIMITS.thought) || !a.thought) fail('approach.thought');
  if (!isNum(a.since_step)) fail('approach.since_step');
  if (!Array.isArray(a.tried) || a.tried.length > LIMITS.triedApproaches) fail('approach.tried');
  a.tried.forEach((t, i) => {
    if (!t || !isStr(t.id, 64) || !isStr(t.approach, LIMITS.approach) || typeof t.steps !== 'string' || !isStr(t.reason, LIMITS.approach)) {
      fail(`approach.tried[${i}]`);
    }
  });
  const i = a.interrupted;
  if (i !== null) {
    if (!i || typeof i !== 'object' || !isStr(i.id, 64) || !isStr(i.approach, LIMITS.approach) || !isNum(i.since_step) || !isStr(i.reason, LIMITS.approach)) {
      fail('approach.interrupted');
    }
  }
  const p = m.progress;
  if (!p || typeof p !== 'object') fail('progress');
  for (const k of ['steps', 'known_floor_cells', 'revealed_since_approach', 'steps_since_approach', 'revisits_last_10', 'coins']) {
    if (!isNum(p[k])) fail(`progress.${k}`);
  }
  if ('confidence' in p) { // present only with the confidence toggle on
    const c = p.confidence;
    if (!c || typeof c !== 'object' || !isNum(c.value) || c.value < 0 || c.value > 100) fail('progress.confidence.value');
    if ('now' in c && (!isNum(c.now) || c.now < 0 || c.now > 100)) fail('progress.confidence.now'); // C (capability + history) as of the last save
    for (const k of ['strikes', 'blocked', 'evaded', 'coins', 'hearts']) {
      if (!Number.isInteger(c.counts?.[k]) || c.counts[k] < 0 || c.counts[k] > LIMITS.confidenceCount) fail(`progress.confidence.counts.${k}`);
    }
  }
  const s = m.sentiment;
  if (!s || typeof s !== 'object' || !MOOD_IDS.includes(s.id) || !isNum(s.since_step)) fail('sentiment');
  if (!Array.isArray(m.sentiment_history) || m.sentiment_history.length > LIMITS.sentimentHistory) fail('sentiment_history');
  m.sentiment_history.forEach((h, i) => {
    if (!h || !MOOD_IDS.includes(h.id) || !isNum(h.step)) fail(`sentiment_history[${i}]`);
  });
  const r = m.recent;
  if (!r || typeof r !== 'object') fail('recent');
  if (!Array.isArray(r.moves) || r.moves.length > LIMITS.recentMoves || r.moves.some((d) => !isStr(d, 16))) fail('recent.moves');
  if (!Array.isArray(r.cells) || !r.cells.length || r.cells.length > LIMITS.recentCells || !r.cells.every(isCell)) fail('recent.cells');
  if (!Number.isInteger(r.back_and_forth) || r.back_and_forth < 0 || r.back_and_forth > LIMITS.recentMoves) fail('recent.back_and_forth');
  const e = m.encounters;
  if (!e || typeof e !== 'object') fail('encounters');
  for (const k of ['count', 'escaped', 'hits', 'dispelled', 'last_at_step']) {
    if (!Number.isInteger(e[k]) || e[k] < 0) fail(`encounters.${k}`);
  }
  if (!Array.isArray(m.events) || m.events.length > LIMITS.events) fail('events');
  m.events.forEach((ev, i) => {
    if (!ev || !isNum(ev.step) || !isStr(ev.text, LIMITS.eventText) || !ev.text) fail(`events[${i}]`);
  });
  if (!Array.isArray(m.skills) || m.skills.length > LIMITS.skills) fail('skills');
  const skillIds = new Set();
  m.skills.forEach((k, i) => {
    if (!k || !isStr(k.id, 64) || !k.id || !isStr(k.kind, 32) || !isStr(k.name, 64) || !isStr(k.text, LIMITS.skillText)
      || typeof k.ready !== 'boolean' || !Number.isInteger(k.cooldown_left) || k.cooldown_left < 0 || (k.ready !== (k.cooldown_left === 0))) fail(`skills[${i}]`);
    if (skillIds.has(k.id)) fail(`skills[${i}] duplicates ${k.id}`);
    skillIds.add(k.id);
  });
  const d = m.directive ?? null;
  if (d !== null) {
    if (typeof d !== 'object' || !isStr(d.text, LIMITS.directive) || !d.text || !isNum(d.from_step) || !isNum(d.until_step) || d.until_step < d.from_step - 1) fail('directive');
  }
  if (!Array.isArray(m.landmarks) || m.landmarks.length > LIMITS.landmarks) fail('landmarks');
  const seen = new Set();
  m.landmarks.forEach((l, i) => {
    if (!l || !LANDMARK_KINDS.includes(l.kind) || !isCell(l.cell) || !isNum(l.step) || !isStr(l.note, LIMITS.landmarkNote)) fail(`landmarks[${i}]`);
    const id = `${l.kind}@${l.cell}`;
    if (seen.has(id)) fail(`landmarks[${i}] duplicates ${id}`);
    seen.add(id);
  });
  return m;
}

export function renderMarkdown(m) {
  const p = m.progress;
  const lines = [`# Explorer memory`, '', `## Approach`, `**Now (since step ${m.approach.since_step}):** ${m.approach.current} _(${m.approach.id})_`, `> “${m.approach.thought}”`];
  const i = m.approach.interrupted;
  if (i) lines.push(`**Interrupted (resumes when the encounter is over):** ${i.approach} _(${i.id}, since step ${i.since_step}; ${i.reason})_`);
  for (const t of m.approach.tried) lines.push(`- ~~${t.approach}~~ _(steps ${t.steps}: ${t.reason})_`);
  const s = m.sentiment;
  lines.push('', '## Mind', `**${s.id}**${s.since_step ? ` since step ${s.since_step}` : ' (default, not yet picked)'}`);
  if (m.sentiment_history.length) lines.push(`- Recent picks: ${m.sentiment_history.map((h) => `${h.id} (step ${h.step})`).join(', ')}`);
  const e = m.encounters;
  lines.push('', '## Encounters', `- ${e.count} met, ${e.escaped} escaped, ${e.hits} hit${e.hits === 1 ? '' : 's'}, ${e.dispelled} dispelled${e.last_at_step ? `, last at step ${e.last_at_step}` : ''}`);
  lines.push('', '## Skills');
  if (!m.skills.length) lines.push('_None._');
  for (const k of m.skills) lines.push(`- **${k.name}** (${k.kind}): ${k.ready ? 'ready' : `ready again in ${k.cooldown_left} step${k.cooldown_left === 1 ? '' : 's'}`}${k.text ? ` — ${k.text}` : ''}`);
  if (m.directive) lines.push('', '## Directive', `“${m.directive.text}” (steps ${m.directive.from_step}-${m.directive.until_step})`);
  lines.push('', '## Events');
  if (!m.events.length) lines.push('_None yet._');
  for (const ev of m.events) lines.push(`- ${ev.text} — _step ${ev.step}_`);
  lines.push('', '## Landmarks');
  if (!m.landmarks.length) lines.push('_None yet._');
  for (const l of m.landmarks) lines.push(`- **${l.kind}** at ${l.cell.join(',')}: ${l.note} — _step ${l.step}_`);
  lines.push(
    '',
    '## Progress',
    `- Steps: ${p.steps}`,
    `- Coins: ${p.coins}`,
    ...(p.confidence ? [`- Confidence: ${p.confidence.value} (${band(p.confidence.value)}; strikes ${p.confidence.counts.strikes}, blocked ${p.confidence.counts.blocked}, evaded ${p.confidence.counts.evaded}, coins ${p.confidence.counts.coins}, hearts ${p.confidence.counts.hearts})`] : []),
    `- Known floor cells: ${p.known_floor_cells}`,
    `- Since this approach: ${p.steps_since_approach} steps, ${p.revealed_since_approach} cells revealed`,
    `- Revisits in the last 10 steps: ${p.revisits_last_10}`,
    `- Last moves: ${m.recent.moves.join(', ') || 'none'} (back and forth ${m.recent.back_and_forth}x)`,
  );
  return lines.join('\n') + '\n';
}

// Validates, then writes both files into dirURL (a directory URL ending in '/').
export async function saveMemory(memory, dirURL) {
  validateMemory(memory);
  const json = JSON.stringify(memory, null, 2);
  await Promise.all([
    writeFile(new URL('memory.json', dirURL), json),
    writeFile(new URL('memory.md', dirURL), renderMarkdown(memory)),
  ]);
  return Math.round(json.length / 4); // approximate tokens
}

// Central config hook (src/config/runtime.js): limits apply from a new game, because memory is validated against them.
export function configureExplorerMemory(o) {
  for (const k of Object.keys(LIMITS)) if (o[`limExplorer_${k}`] !== undefined) LIMITS[k] = o[`limExplorer_${k}`];
}
// The values in force, keyed like the registry (the config check compares them with the registry defaults).
export const explorerMemorySnapshot = () => Object.fromEntries(Object.keys(LIMITS).filter((k) => k !== 'confidenceCount').map((k) => [`limExplorer_${k}`, LIMITS[k]]));
