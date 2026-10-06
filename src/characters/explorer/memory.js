// The explorer's memory: the only state Jev sees between steps.
//
// memory.json is the source of truth (structured, validated, size-capped, and what
// Jev reads; questions point at fields like `memory.approach.current`). memory.md is a
// readable rendering of the same thing for people; nothing reads it back.
//
//   objective      - what the explorer is trying to do
//   approach       - how it is currently exploring, plus approaches tried and dropped
//                    (Jev reviews it every few steps)
//   findings       - notable facts discovered on the way (e.g. the chest was spotted)
//   progress       - counters the approach review is judged from
//   latest_action  - Jev's last next_move answer, verbatim (or the forced move)
//   danger         - safe or chased (since which step) and how many adversaries were seen
//   sentiment      - the mood Jev picked at the latest approach decision ({ id, since_step,
//                    profile_note }); its code profile changes behaviour (see brain.js)
//   sentiment_history - the last few picks, [{ id, step }]
//
// `approach.thought` is a short first-person line for the current approach (the UI's thought
// bubble). An encounter tactic (slip_past, run_away, ...) is not a verdict on the approach it
// interrupted: that approach is parked in `approach.interrupted` (never in `tried`) and restored
// once the encounter is over. Tactics themselves never go into `tried` either.
//
// Zero dependencies: hand-written validation instead of zod.
import { writeFile } from 'node:fs/promises';

export const LIMITS = {
  objective: 400, // characters
  approach: 240,
  triedApproaches: 5,
  findings: 12, // oldest dropped first
  fact: 200,
  thought: 60,
  profileNote: 200,
  sentimentHistory: 5,
};

const WINDOW = 10; // revisits_last_10
// The rolling window of revisit flags lives outside the memory object, so it never
// reaches JSON.stringify (Jev's state, memory.json, the browser).
const revisitWindows = new WeakMap();

export function createMemory({ objective, approachId, approachText, thought, sentiment }) {
  const memory = {
    objective: objective.slice(0, LIMITS.objective),
    approach: {
      id: approachId, current: approachText.slice(0, LIMITS.approach), thought: thought.slice(0, LIMITS.thought), since_step: 1, tried: [], interrupted: null,
    },
    findings: [],
    progress: { steps: 0, known_floor_cells: 0, revealed_since_approach: 0, steps_since_approach: 0, revisits_last_10: 0 },
    latest_action: null,
    danger: { status: 'safe', since_step: 0, adversaries_seen: 0 },
    sentiment: { id: sentiment.id, since_step: 0, profile_note: sentiment.profile_note.slice(0, LIMITS.profileNote) },
    sentiment_history: [],
  };
  revisitWindows.set(memory, []);
  return memory;
}

// Called once per step, after the move was applied.
export function recordStep(memory, { step, dir, revealed, revisit, known_floor_cells, decision, forced }) {
  const p = memory.progress;
  p.steps = step;
  p.known_floor_cells = known_floor_cells;
  p.revealed_since_approach += revealed;
  p.steps_since_approach += 1;
  const window = revisitWindows.get(memory) ?? [];
  window.push(Boolean(revisit));
  if (window.length > WINDOW) window.shift();
  revisitWindows.set(memory, window);
  p.revisits_last_10 = window.filter(Boolean).length;
  memory.latest_action = forced || !decision
    ? { choice: dir, confidence: null, probabilities: null, forced: true }
    : { choice: decision.choice, confidence: decision.confidence, probabilities: decision.probabilities, forced: false };
}

// Adds a fact unless it is already known, and keeps the newest LIMITS.findings.
export function addFinding(memory, fact, step) {
  const text = String(fact).trim().slice(0, LIMITS.fact);
  if (!text) return;
  if (memory.findings.some((f) => f.fact.toLowerCase() === text.toLowerCase())) return;
  memory.findings.push({ fact: text, step });
  // Evict the oldest finding, but never the chest one: repeated chase findings would otherwise push it out.
  while (memory.findings.length > LIMITS.findings) {
    const i = memory.findings.findIndex((f) => !/treasure chest/i.test(f.fact));
    memory.findings.splice(i === -1 ? 0 : i, 1);
  }
}

// Drops the current approach (with why) and starts a new one from the next step.
// Never call it with a tactic as the current approach: tactics are parked/replaced, not "tried".
export function switchApproach(memory, { id, text, thought }, reason, step) {
  const a = memory.approach;
  a.tried.push({ id: a.id, approach: a.current, steps: `${a.since_step}–${step}`, reason: String(reason).slice(0, LIMITS.approach) });
  a.tried = a.tried.slice(-LIMITS.triedApproaches);
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

// Replaces the parked approach, e.g. the chest was spotted mid-chase: after the chase the explorer
// should head for the chest, not resume exploring. The dropped one goes into `tried` with `reason`.
export function replaceInterrupted(memory, { id, text }, reason, step) {
  const a = memory.approach;
  const old = a.interrupted;
  if (old) {
    a.tried.push({ id: old.id, approach: old.approach, steps: `${old.since_step}–${step}`, reason: String(reason).slice(0, LIMITS.approach) });
    a.tried = a.tried.slice(-LIMITS.triedApproaches);
  }
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
export function setSentiment(memory, { id, profile_note }, step) {
  const s = memory.sentiment;
  if (s.id !== id) {
    s.id = id;
    s.since_step = step;
  }
  s.profile_note = String(profile_note).slice(0, LIMITS.profileNote);
  memory.sentiment_history.push({ id, step });
  memory.sentiment_history = memory.sentiment_history.slice(-LIMITS.sentimentHistory);
}

export function setDanger(memory, status, step) {
  memory.danger.status = status;
  memory.danger.since_step = step;
}

// A memory that breaks the schema is a bug: fail loudly.
export function validateMemory(m) {
  const fail = (msg) => {
    throw new Error(`Invalid memory: ${msg}`);
  };
  const isStr = (v, max) => typeof v === 'string' && v.length <= max;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!m || typeof m !== 'object') fail('not an object');
  if (!isStr(m.objective, LIMITS.objective)) fail('objective');
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
  if (!Array.isArray(m.findings) || m.findings.length > LIMITS.findings) fail('findings');
  m.findings.forEach((f, i) => {
    if (!f || !isStr(f.fact, LIMITS.fact) || !isNum(f.step)) fail(`findings[${i}]`);
  });
  const p = m.progress;
  if (!p || typeof p !== 'object') fail('progress');
  for (const k of ['steps', 'known_floor_cells', 'revealed_since_approach', 'steps_since_approach', 'revisits_last_10']) {
    if (!isNum(p[k])) fail(`progress.${k}`);
  }
  const l = m.latest_action;
  if (l !== null) {
    if (typeof l !== 'object' || typeof l.choice !== 'string' || typeof l.forced !== 'boolean') fail('latest_action');
    if (l.confidence !== null && !isNum(l.confidence)) fail('latest_action.confidence');
    if (l.probabilities !== null && typeof l.probabilities !== 'object') fail('latest_action.probabilities');
  }
  const d = m.danger;
  if (!d || typeof d !== 'object') fail('danger');
  if (d.status !== 'safe' && d.status !== 'chased') fail('danger.status');
  if (!isNum(d.since_step)) fail('danger.since_step');
  if (!Number.isInteger(d.adversaries_seen) || d.adversaries_seen < 0) fail('danger.adversaries_seen');
  const s = m.sentiment;
  if (!s || typeof s !== 'object' || !isStr(s.id, 32) || !s.id || !isNum(s.since_step) || !isStr(s.profile_note, LIMITS.profileNote)) fail('sentiment');
  if (!Array.isArray(m.sentiment_history) || m.sentiment_history.length > LIMITS.sentimentHistory) fail('sentiment_history');
  m.sentiment_history.forEach((h, i) => {
    if (!h || !isStr(h.id, 32) || !isNum(h.step)) fail(`sentiment_history[${i}]`);
  });
  return m;
}

export function renderMarkdown(m) {
  const p = m.progress;
  const lines = [`# Explorer memory`, '', `## Objective`, m.objective, '', `## Approach`, `**Now (since step ${m.approach.since_step}):** ${m.approach.current} _(${m.approach.id})_`, `> “${m.approach.thought}”`];
  const i = m.approach.interrupted;
  if (i) lines.push(`**Interrupted (resumes when the encounter is over):** ${i.approach} _(${i.id}, since step ${i.since_step}; ${i.reason})_`);
  for (const t of m.approach.tried) lines.push(`- ~~${t.approach}~~ _(steps ${t.steps}: ${t.reason})_`);
  const d = m.danger;
  lines.push(
    '',
    '## Danger',
    d.status === 'chased' ? `**Chased** since step ${d.since_step}` : d.since_step ? `**Safe** since step ${d.since_step}` : '**Safe**',
    `- Adversaries seen: ${d.adversaries_seen}`,
  );
  const s = m.sentiment;
  lines.push('', '## Sentiment', `**${s.id}**${s.since_step ? ` since step ${s.since_step}` : ' (default, not yet picked)'}: ${s.profile_note}`);
  if (m.sentiment_history.length) lines.push(`- Recent picks: ${m.sentiment_history.map((h) => `${h.id} (step ${h.step})`).join(', ')}`);
  lines.push('', '## Findings');
  if (!m.findings.length) lines.push('_None yet._');
  for (const f of m.findings) lines.push(`- ${f.fact} — _step ${f.step}_`);
  lines.push(
    '',
    '## Progress',
    `- Steps: ${p.steps}`,
    `- Known floor cells: ${p.known_floor_cells}`,
    `- Since this approach: ${p.steps_since_approach} steps, ${p.revealed_since_approach} cells revealed`,
    `- Revisits in the last 10 steps: ${p.revisits_last_10}`,
    '',
    '## Latest action (Jev)',
  );
  const l = m.latest_action;
  if (!l) lines.push('_None yet._');
  else if (l.forced) lines.push(`**${l.choice}** (forced: the only legal move)`);
  else lines.push(`**${l.choice}** (confidence ${l.confidence?.toFixed?.(2)})`);
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
