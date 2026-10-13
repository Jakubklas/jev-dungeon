// Browser side: draws the dungeon and runs the step loop. All game logic and every
// Jev call live on the server; this file only asks for one step at a time.
import { THOUGHTS, MOOD_THOUGHTS, TROLL_THOUGHTS, TREE_GIANT_THOUGHTS, WOLF_THOUGHTS } from './thoughts.js';
import { createRenderer, configureRenderer, DASH_MS } from './render.js';

const $ = (id) => document.getElementById(id);
const canvas = $('board');

let LOG_MAX = 12;       // event log length
let FIRE_CALL_MS = 550;          // the explorer shouts this long before the fire strike's step lands and the blast plays
const FIRE_SHOUT = 'Fire Strike!';
let FIRE_MS = 1490;             // the fire strike's blast (the renderer has the same knob: configureRenderer below)
let BUBBLE_IN = 200, BUBBLE_OUT = 400;
const DIR_ORDER = ['up', 'down', 'left', 'right'];
const EXPLORER_MOVES = [...DIR_ORDER, 'stay']; // the explorer can also stand still

let game = null;          // publicView from the server
let memory = null;
let running = false;      // the user wants steps to keep coming
let looping = false;      // the step loop is alive (at most one at a time)
let epoch = 0;            // bumps on Reload so answers about an old game are dropped
let lastReview = null;    // turn.review is null on most turns; keep the latest real one
let lastDecision = null;  // v4 approach decision (turn.decision with a trigger); null on most turns
let lastLatency = null;   // last apiMs of a turn that actually called Jev
let advTurns = new Map(); // id -> this tick's adversaryTurn (v3), cleared every step
let advLatency = null;    // slowest adversary Jev call this tick, null when none called Jev
let approachesUsed = new Set();
let eventLog = [];        // newest first: { step, text, type }
let lastConfidence = null; // turn.confidence ({ value, band, delta, reason }); null with the confidenceModel toggle off
let lastSkillDecision = null; // turn.skill_decision with its step, null before the first one
let elapsed = 0, resumedAt = 0;
let directive = null;     // the live whisper { text, from_step, until_step, steps_left } or null
let cooldownUntil = 0;    // performance.now() time the Send button unlocks
let sendBusy = false;
let whisperOff = false;  // the server answered 403: directives are switched off in the settings
let whisperCooldownMs = 10000; // from the injectCooldownS setting

const delayMs = () => Number($('delay').value);
const playTime = () => elapsed + (running ? performance.now() - resumedAt : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const revealOn = () => $('reveal').checked;
// The isometric renderer lives in render.js; this page feeds it the view and reads its head positions for the bubbles.
const renderer = createRenderer(canvas, {
  wrap: $('board-wrap'),
  minimap: $('minimap'),
  reveal: revealOn,
  routeDebug: () => $('route-debug').checked,
  landmarks: () => validLandmarks().map((l) => ({ cell: l.cell, colour: landmarkKind(l.kind).colour })),
});
const routeOf = () => {
  const r = game?.route;
  return r && typeof r === 'object' ? r : null;
};

function formatTime(ms) {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

function setStatus(text, isError = false) {
  $('status').textContent = isError ? text : '';
  $('status').hidden = !isError;
}

// ?testbed&size=9x9&numAdversaries=2&props=few opens a small test arena instead of a dungeon
// (src/testbed.js; keys and values are validated on the server). Reload keeps the same arena.
const query = new URLSearchParams(location.search);
const TESTBED = query.has('testbed') ? Object.fromEntries(query) : null;

async function api(method, path) {
  const body = method !== 'POST' ? undefined : JSON.stringify(path === '/api/new' && TESTBED ? { testbed: TESTBED } : {});
  const res = await fetch(path.replace(/^\//, ''), { method, headers: { 'Content-Type': 'application/json' }, body });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}


// ---------- thought bubbles ----------
// When a character settles on a new approach in its memory, its text floats over the
// character's head for a few readable seconds, then fades. One bubble per character: a new
// approach replaces the text and restarts the timer. Keyed on id@since_step, so resuming a
// parked approach counts as a new thought. A bubble shows only while its character is drawn
// (fog), dimmed like the character under Reveal map; its timer runs on regardless.

const bubbleLayer = $('bubbles');
const thoughts = new Map(); // id -> { key, text, t0, ms, el }

const bubbleMs = (text) => Math.min(9000, Math.max(3500, 1200 + text.length * 50));

// tag: the explorer's sentiment id (v4), shown as a chip on the bubble. The bubble shows only when the approach changes
// (PLAN-moods): a new mood on the same approach does not re-show it.
function think(id, key, text, kind, tag = null) {
  let t = thoughts.get(id);
  if (!t) {
    const node = el('div', '', `bubble ${kind}`);
    bubbleLayer.append(node);
    t = { key: null, tag: null, el: node };
    thoughts.set(id, t);
  }
  if (t.key === key) return;
  t.key = key;
  t.tag = tag;
  if (typeof text === 'function') text = text();
  if (!text) return;
  t.text = text;
  t.t0 = performance.now();
  t.ms = bubbleMs(text);
  t.el.replaceChildren(text);
  if (tag) {
    t.el.dataset.sentiment = tag;
    t.el.append(el('span', label(tag), 'senti-tag'));
  } else {
    delete t.el.dataset.sentiment;
  }
}

// Each monster kind speaks in its own voice on an event (struck, hit, ...). Shows its own text without touching the approach key, so the
// approach line does not come back at the next view.
function shout(id, type) {
  const kind = game?.adversaries?.find((a) => a.id === id)?.kind;
  const pool = MONSTER_THOUGHTS[kind]?.[type];
  if (!pool) return;
  let t = thoughts.get(id);
  if (!t) {
    t = { key: null, tag: null, el: el('div', '', 'bubble adversary') };
    bubbleLayer.append(t.el);
    thoughts.set(id, t);
  }
  const text = thoughtFor(id, type, null, null, kind);
  t.text = text;
  t.t0 = performance.now();
  t.ms = bubbleMs(text);
  t.el.replaceChildren(text);
  delete t.el.dataset.sentiment;
}

// Short first-person lines per approach id (explorer and ghosts). One is picked at random each time a
// bubble shows, never the one the same character showed last. Visual only: no server state, no rng().
// Mood lines for the explorer (PLAN-moods): shown when the approach changes, picked at random like THOUGHTS.
// Monster voices are keyed by approach id and combat event: troll roars, ancient tree warnings, wolf pack calls.
// See shout() for event bubbles. Visual only, like THOUGHTS.
const MONSTER_THOUGHTS = { troll: TROLL_THOUGHTS, tree_giant: TREE_GIANT_THOUGHTS, wolf: WOLF_THOUGHTS };
const lastPick = new Map(); // character id -> last line shown
function thoughtFor(charId, approachId, fallback, moodId = null, kind = null) {
  const pool = (moodId && MOOD_THOUGHTS[moodId]) || MONSTER_THOUGHTS[kind]?.[approachId] || THOUGHTS[approachId];
  if (!pool) return fallback;
  const prev = lastPick.get(charId);
  const fresh = pool.filter((t) => t !== prev);
  const options = fresh.length ? fresh : pool; // a one-line pool (e.g. troll 'caught') repeats rather than picking nothing
  const pick = options[Math.floor(Math.random() * options.length)];
  lastPick.set(charId, pick);
  return pick;
}

// The approach each character holds now, as { id, key, text, kind } (text null = no thought).
function currentApproaches() {
  const out = [];
  if (memory?.approach) {
    const a = memory.approach;
    // v4: the first-person thought, tagged with the sentiment; older backends only have `current`.
    out.push({ id: '@', key: `${a.id}@${a.since_step}`, text: () => thoughtFor('@', a.id, a.thought || a.current, memory.sentiment?.id), kind: 'explorer', tag: memory.sentiment?.id ?? null });
  }
  for (const ad of game?.adversaries ?? []) {
    const br = ad.brain;
    // Brain off is code patrol, not a formulated approach: no bubble.
    out.push({ id: ad.id, key: `${br?.approach}@${br?.approach_since}`, text: br?.approach ? () => thoughtFor(ad.id, br.approach, br.approach_text, null, ad.kind) : null, kind: 'adversary' });
  }
  return out;
}

// After every new view. prime: note the current approaches without showing them.
// The explorer's code-chosen remark (view().explorer.remark, string or null; absent = nothing) shows once per new
// remark in the explorer's bubble. It borrows the bubble, then the approach key is put back so the approach line
// does not re-show on the next view.
let lastRemark = null;
function updateThoughts(prime = false) {
  const list = currentApproaches();
  const shouting = performance.now() < shoutUntil;
  for (const c of list) if (!(shouting && c.id === '@')) think(c.id, c.key, prime ? null : c.text, c.kind, c.tag);
  const remark = game?.explorer?.remark;
  const text = typeof remark === 'string' && remark.trim() ? remark.trim() : null;
  if (text && text !== lastRemark && !prime) {
    const t = thoughts.get('@');
    const approachKey = t?.key ?? null, approachTag = t?.tag ?? null;
    think('@', `remark:${text}`, text, 'explorer');
    const t2 = thoughts.get('@');
    t2.key = approachKey; t2.tag = approachTag;
  }
  lastRemark = text;
}

// Skill callouts borrow the explorer's bubble like a remark, then restore the approach key.
// A new approach line waits until the callout's hold has passed.
let shoutUntil = 0;
function explorerShout(text, holdMs = FIRE_CALL_MS + FIRE_MS / 2) {
  shoutUntil = performance.now() + holdMs;
  const t = thoughts.get('@');
  const approachKey = t?.key ?? null, approachTag = t?.tag ?? null;
  think('@', `shout:${text}:${performance.now()}`, text, 'explorer');
  const t2 = thoughts.get('@');
  t2.key = approachKey; t2.tag = approachTag;
}

function clearThoughts() {
  lastRemark = null;
  shoutUntil = 0;
  thoughts.clear();
  bubbleLayer.replaceChildren();
}

function drawBubbles(now) {
  const { S, dpr, viewW } = renderer.metrics();
  const heads = renderer.heads;
  const k = S / dpr; // buf px -> CSS px
  const placed = []; // rects already laid out this frame; the explorer's (first) never moves
  for (const [id, t] of thoughts) {
    const head = heads.get(id);
    const age = now - (t.t0 ?? -Infinity);
    const fade = Math.min(1, age / BUBBLE_IN, (t.ms - age) / BUBBLE_OUT);
    if (!head || !t.text || fade <= 0) {
      t.el.style.opacity = '0';
      continue;
    }
    const w = t.el.offsetWidth, h = t.el.offsetHeight;
    const hx = head.x * k, hy = head.y * k - 10;
    const x = Math.max(6, Math.min(viewW - w - 6, hx - w / 2));
    let y = hy - h;
    // Characters close together: lift this bubble above any it would overlap.
    for (const r of placed) if (x < r.x + r.w && r.x < x + w && y < r.y + r.h + 14 && r.y < y + h) y = Math.min(y, r.y - h - 14);
    y = Math.max(6, y);
    placed.push({ x, y, w, h });
    t.el.style.setProperty('--tail', `${Math.max(10, Math.min(w - 10, hx - x))}px`);
    t.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y + (1 - fade) * 4)}px)`;
    t.el.style.opacity = String(fade * head.alpha);
  }
}


// Progress strip and cue toast: DOM, refreshed from the frame loop only when the values change.
let routeKey = '', cueText = null; // cueText: the cue of the current continuous non-null run
function syncRoute() {
  const r = routeOf();
  const prog = r && Number.isFinite(r.progress) ? Math.min(1, Math.max(0, r.progress)) : null;
  const fur = r && Number.isFinite(r.furthest) ? Math.min(1, Math.max(0, r.furthest)) : prog;
  const state = r && typeof r.state === 'string' ? r.state : '';
  const cue = r && typeof r.cue === 'string' && r.cue ? r.cue : null;
  const key = `${prog}|${fur}|${state}|${cue}`;
  if (key === routeKey) return;
  routeKey = key;
  $('route-stat').hidden = prog == null;
  if (prog != null) {
    $('route-fill').style.width = `${Math.round(prog * 100)}%`;
    $('route-fill').dataset.state = state;
    $('route-tick').style.left = `${Math.round(fur * 100)}%`;
    $('route-state').textContent = state;
    $('route-stat').title = `Route progress ${Math.round(prog * 100)}%, furthest ${Math.round(fur * 100)}%`;
  }
  const toast = $('route-cue');
  if (cue) {
    toast.textContent = cue; // text updates in place if it changes mid-run; no re-pop
    toast.classList.add('on');
    if (cueText == null) { // first frame of a run: log once
      eventLog.unshift({ step: game?.steps ?? 0, text: cue, type: 'cue' });
      eventLog.length = Math.min(eventLog.length, LOG_MAX);
      renderDanger();
    }
  } else {
    toast.classList.remove('on'); // keeps the old text while it fades out
  }
  cueText = cue;
}


// ---------- control pane ----------

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

// Ids -> readable labels. `escape` is the pre-v4 name of `run_away`; accept both while the
// backend may still send the old one.
const LABELS = { escape: 'run away', run_away: 'run away' };
const normId = (id) => (id === 'escape' ? 'run_away' : id);
const label = (id) => (id == null ? '—' : LABELS[id] ?? String(id).replace(/_/g, ' '));

// Option text for a tactic: options may be an { id: text } map or an [{ id, text }] list.
function optionText(options, id) {
  if (!options) return null;
  if (Array.isArray(options)) {
    const o = options.find((x) => x && normId(x.id) === normId(id));
    return o ? o.text ?? o.description ?? o.thought ?? null : null;
  }
  return options[id] ?? options[normId(id)] ?? (normId(id) === 'run_away' ? options.escape : null) ?? null;
}

// Label | bar | % rows into a .probs grid, highest first, chosen one highlighted.
function probRows(probs, chosen, { title, tint } = {}) {
  const entries = Object.entries(probs ?? (chosen ? { [chosen]: 1 } : {})).sort((p, q) => q[1] - p[1]);
  return entries.flatMap(([id, p]) => {
    const isChosen = chosen != null && normId(id) === normId(chosen);
    const hint = title?.(id);
    const bar = el('span', null, `bar${isChosen ? ' chosen' : ''}`);
    const fill = el('i');
    fill.style.width = `${Math.round((p ?? 0) * 100)}%`;
    bar.append(fill);
    const row = [el('span', label(id), isChosen ? 'chosen' : ''), bar, el('span', `${Math.round((p ?? 0) * 100)}%`, 'num')];
    for (const n of row) {
      if (hint) n.title = `${label(id)}: ${hint}`;
      if (tint) n.dataset.sentiment = id;
    }
    return row;
  });
}

// Short static description per sentiment (the backend no longer sends a profile note).
const SENTIMENT_NOTES = {
  wary: 'Wary: gets away first, keeps its distance and avoids dead ends.',
  steady: 'Steady: sticks to the plan, explores and takes coins on the way.',
  greedy: 'Greedy: after coins and unexplored rooms; detours are fine.',
  bold: 'Bold: takes the fight, single monster or several.',
  panic: 'Panic: gets away at any cost; only the way out matters.',
  guarded: 'Guarded: explores away from enemies; no detours, no fights.',
  cautious: 'Cautious: keeps its distance and slips past; fights only a hurt monster or when cornered.',
  fearless: 'Fearless: hunts enemies down, even several at once.',
};

// Landmarks (fog-safe: they are known cells). One colour and glyph per kind.
const LANDMARK_KINDS = {
  exit: { text: 'Portal', glyph: '▣', colour: '#ffc633' },
  dead_end_explored: { text: 'Dead end', glyph: '■', colour: '#8f9bb8' },
  hit_here: { text: 'Hit here', glyph: '✖', colour: '#ff6a55' },
  hiding_spot_used: { text: 'Hiding spot', glyph: '◆', colour: '#7ee8ff' },
};
const landmarkKind = (k) => LANDMARK_KINDS[k] ?? { text: label(k), glyph: '●', colour: '#c9b8ff' };
const validLandmarks = () => (Array.isArray(memory?.landmarks) ? memory.landmarks : [])
  .filter((l) => Array.isArray(l?.cell) && l.cell.length === 2 && Number.isFinite(l.cell[0]) && Number.isFinite(l.cell[1]));
const MOVE_ARROWS = { up: '↑', down: '↓', left: '←', right: '→', stay: '·' };

function renderMind() {
  const s = memory?.sentiment;
  const chip = $('sentiment-chip');
  chip.textContent = s ? label(s.id) : '—';
  if (s) chip.dataset.sentiment = s.id;
  else delete chip.dataset.sentiment;
  $('sentiment-since').textContent = s?.since_step != null ? `since step ${s.since_step}` : '';
  $('profile-note').textContent = s ? (SENTIMENT_NOTES[s.id] ?? '') : 'No sentiment yet.';
  const hist = (memory?.sentiment_history ?? []).slice(-5).reverse();
  $('sentiment-history').replaceChildren(...hist.map((h) => {
    const li = el('li', `${label(h.id)} `);
    li.dataset.sentiment = h.id;
    li.append(el('span', `@${h.step}`));
    li.title = `${label(h.id)} from step ${h.step}`;
    return li;
  }));

  const d = lastDecision;
  $('decision').hidden = !d;
  if (!d) return;
  const head = $('decision-head');
  const parts = [`Step ${d.step} · ${label(d.trigger)}`];
  if (d.apiMs) parts.push(`${Math.round(d.apiMs)} ms`);
  head.replaceChildren(el('span', `${parts.join(' · ')}: `, 'muted'), el('b', label(d.tacticId)));
  const sp = d.sentiment;
  const sentRows = sp ? [el('span', 'sentiment', 'group'), ...probRows(sp.probabilities, sp.choice, { tint: true })] : [];
  $('sentiment-probs').replaceChildren(...sentRows);
  const tc = d.tactic;
  const tacRows = tc ? [el('span', 'tactic', 'group'), ...probRows(tc.probabilities, tc.choice, { title: (id) => optionText(tc.options, id) })] : [];
  $('tactic-probs').replaceChildren(...tacRows);
  // The chosen tactic's bar takes the chosen sentiment's tint.
  if (sp?.choice) $('tactic-probs').dataset.sentiment = sp.choice;
  else delete $('tactic-probs').dataset.sentiment;
}

// Skills (S5): memory.skills = [{ id, kind, name, text, ready, cooldown_left }], at most 4. The
// block is hidden when the memory has no skills. The skill used this turn is highlighted; the
// choice may carry an aim suffix (sword_strike_left), so match on the id prefix too.
function renderSkills() {
  const list = Array.isArray(memory?.skills) ? memory.skills.filter((k) => k && k.id != null).slice(0, 4) : [];
  $('skills-panel').hidden = !list.length;
  if (!list.length) return;
  const sd = lastSkillDecision;
  const choice = sd?.choice != null ? String(sd.choice) : null;
  const usedNow = !!sd?.used && choice && choice !== 'none';
  $('skills').replaceChildren(...list.map((k) => {
    const id = String(k.id);
    const used = usedNow && (choice === id || choice.startsWith(`${id}_`));
    const ready = k.ready !== false && !(k.cooldown_left > 0);
    const li = el('li', null, `skill${used ? ' used' : ''}${ready ? '' : ' cooling'}`);
    if (k.text) li.title = k.text;
    li.append(
      el('i', null, 'skill-pip'),
      el('b', k.name ?? label(id), 'skill-name'),
      el('span', k.kind ? label(k.kind) : '', 'skill-kind'),
      el('span', ready ? 'ready' : `cooldown ${k.cooldown_left ?? '?'}${k.kind === 'dash' ? 's' : ''}`, 'skill-state'),
    );
    if (used) li.append(el('span', 'used', 'skill-used'));
    return li;
  }));
  const note = $('skill-note');
  note.hidden = !sd || choice == null;
  if (!note.hidden) {
    const p = sd.probabilities?.[sd.choice];
    note.textContent = `Step ${sd.step}: ${choice === 'none' ? 'no skill' : label(choice)}${p != null ? ` (${Math.round(p * 100)}%)` : ''}${sd.used ? '' : choice === 'none' ? '' : ', not used'}.`;
  }
}

// 8-bit hearts: one per life, filled while it lasts (half filled for a half life left by regen).
const HEART_ROWS = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
function renderHearts() {
  const max = game?.max_health ?? 0, hp = game?.health ?? 0;
  const NS = 'http://www.w3.org/2000/svg';
  const svgs = [];
  for (let i = 0; i < max; i++) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 7 6');
    const part = Math.min(1, Math.max(0, hp - i)); // regen can leave a fractional life: a half heart fills its left half
    svg.setAttribute('class', part >= 1 ? 'full' : 'empty');
    HEART_ROWS.forEach((row, y) => [...row].forEach((c, x) => {
      if (c !== 'X') return;
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1); r.setAttribute('height', 1);
      if (part > 0 && part < 1 && x < Math.round(7 * part)) r.setAttribute('class', 'on');
      svg.append(r);
    }));
    svgs.push(svg);
  }
  const box = $('hearts');
  box.replaceChildren(...(svgs.length ? svgs : ['—']));
  box.setAttribute('aria-label', `${hp} of ${max} lives`);
}

let shownCoins = 0;
function renderCoins() {
  const n = game?.coins ?? 0;
  const box = $('coins');
  box.textContent = n;
  if (n > shownCoins) { // gold pop on a pickup
    box.classList.remove('pop');
    void box.offsetWidth;
    box.classList.add('pop');
  }
  shownCoins = n;
}

// Confidence meter (PLAN-confidence C3): a bar and the band word. It shows the score from the last turn, or, before
// the first step, the 50 the memory starts at; it is hidden when neither the Confidence model nor the Confidence meter
// setting is on (no `confidence` in the turn or in memory.progress).
const CONFIDENCE_BANDS = [[80, 'dominant'], [65, 'sure'], [40, 'even'], [30, 'unsure']]; // the thresholds of confidence.js band()
function renderConfidence() {
  const stat = $('confidence-stat');
  if (!stat) return;
  const fromMemory = memory?.progress?.confidence;
  const memC = fromMemory ? (fromMemory.now ?? fromMemory.value) : null; // C as of the last save (the history score on older saves)
  const c = lastConfidence ?? (fromMemory ? { value: memC, band: (CONFIDENCE_BANDS.find(([lo]) => memC >= lo) ?? [0, 'shaken'])[1], delta: 0 } : null);
  stat.hidden = !c;
  if (!c) return;
  const v = Math.max(0, Math.min(100, Number(c.value) || 0));
  $('confidence-fill').style.width = `${v}%`;
  $('confidence-fill').dataset.band = c.band;
  $('confidence-band').textContent = `${Math.floor(v)} ${c.band}`;
  $('confidence-band').title = c.panic ? 'panic' : c.tier ? `${c.tier} tier` : '';
  stat.title = `Confidence ${v.toFixed(1)}/100 (${c.band})${c.delta ? `, ${c.delta > 0 ? '+' : ''}${c.delta}${c.reason ? ` from ${c.reason}` : ''}` : ''}`;
}

function renderMemory() {
  renderHearts();
  renderConfidence();
  renderCoins();
  $('steps').textContent = game ? game.steps : 0;
  $('explored').textContent = game ? `${Math.round(game.explored_pct)}%` : '0%';
  $('latency').textContent = lastLatency == null ? '—' : `${lastLatency} ms`;
  $('adv-latency').textContent = advLatency == null ? '—' : `${advLatency} ms`;
  $('mapsize').textContent = game ? `${game.width}×${game.height}` : '—';
  renderDanger();
  renderAdversaries();
  renderMind();
  renderSkills();
  if (!memory) { renderRecent(); renderEvents(); renderLandmarks(); return; }

  const ap = memory.approach;
  $('approach').textContent = ap?.current ?? '—';
  $('approach-since').textContent = ap?.since_step != null ? `(since step ${ap.since_step})` : '';
  if (ap?.id) approachesUsed.add(ap.id);
  const tried = Array.isArray(ap?.tried) ? ap.tried : [];
  const items = tried.map((t) => {
    if (t.id) approachesUsed.add(t.id);
    const li = el('li');
    li.append(el('s', t.approach ?? label(t.id)), el('span', ` steps ${t.steps ?? '?'}${t.reason ? `: ${t.reason}` : ''}`, 'why'));
    return li;
  });
  if (ap?.interrupted) {
    const it = ap.interrupted;
    const li = el('li', null, 'interrupted');
    li.append(el('b', 'paused: '), el('span', `${it.approach ?? label(it.id)}${it.since_step != null ? ` (from step ${it.since_step})` : ''}${it.reason ? ` · ${it.reason}` : ''}`, 'why'));
    items.unshift(li);
  }
  $('tried').replaceChildren(...items);
  renderRecent();
  renderEvents();
  renderLandmarks();
}

function renderRecent() {
  const r = memory?.recent;
  const moves = Array.isArray(r?.moves) ? r.moves : [];
  $('recent').hidden = !moves.length;
  if (!moves.length) return;
  const row = $('recent-moves');
  row.replaceChildren(...moves.map((m) => {
    const sp = el('span', MOVE_ARROWS[m] ?? '?', 'mv');
    sp.title = m;
    return sp;
  }));
  const bf = Number(r.back_and_forth);
  $('recent-bf').hidden = !(bf >= 2);
  $('recent-bf').textContent = bf >= 2 ? `back and forth ×${bf}` : '';
}

function renderEvents() {
  const ev = Array.isArray(memory?.events) ? [...memory.events].reverse() : [];
  $('mem-events').replaceChildren(...(ev.length
    ? ev.map((e) => {
      const li = el('li', `${e.text ?? ''} `);
      if (e.step != null) li.append(el('span', `step ${e.step}`, 'step'));
      return li;
    })
    : [el('li', 'None yet.', 'muted')]));
  const en = memory?.encounters;
  $('encounters').hidden = !en;
  if (en) {
    const parts = [`Encounters ${en.count ?? 0}`];
    if (en.escaped != null) parts.push(`escaped ${en.escaped}`);
    if (en.hits != null) parts.push(`hits ${en.hits}`);
    $('encounters').textContent = parts.join(' · ');
  }
}

function renderLandmarks() {
  const list = validLandmarks();
  $('landmarks-panel').hidden = !list.length;
  $('landmarks').replaceChildren(...[...list].reverse().map((l) => {
    const k = landmarkKind(l.kind);
    const li = el('li');
    const g = el('span', k.glyph, 'lm-glyph');
    g.style.color = k.colour;
    li.append(g, el('b', ` ${k.text} `), el('span', `(${l.cell[0]},${l.cell[1]})`, 'step'));
    if (l.note) li.append(el('span', ` ${l.note}`, 'lm-note'));
    if (l.step != null) li.append(el('span', ` step ${l.step}`, 'step'));
    return li;
  }));
}

// Safe / Chased: from the adversaries the game view says are in sight and chasing.
function dangerStatus() {
  return (game?.adversaries ?? []).some((a) => a.visible && a.mode === 'chase') ? 'chased' : 'safe';
}

function renderDanger() {
  const status = game?.lost ? 'caught' : dangerStatus();
  const chip = $('danger-chip');
  chip.textContent = status === 'caught' ? 'Caught' : status === 'chased' ? 'Chased' : 'Safe';
  chip.className = `chip ${status === 'safe' ? 'safe' : 'chased'}`;

  const visible = (game?.adversaries ?? []).filter((a) => a.visible).length;
  const parts = [`In sight now: ${visible}.`];
  const last = memory?.encounters?.last_at_step;
  if (last != null && memory.encounters.count > 0) parts.push(`Last encounter at step ${last}.`);
  $('danger').textContent = parts.join(' ');
  $('danger').className = status === 'safe' ? 'muted' : '';

  $('events').replaceChildren(...eventLog.map((e) => {
    const li = el('li', `${e.text} `, ['caught', 'hit', 'strike', 'blocked', 'dispelled', 'struck', 'bump', 'coin', 'coin_drop', 'heart', 'regen'].includes(e.type) ? e.type : e.type.startsWith('brain_') || e.type === 'decision' ? e.type : '');
    li.append(el('span', `(step ${e.step})`));
    return li;
  }));
}

const lives = (n) => `${n} ${n === 1 ? 'life' : 'lives'} left`;
const EVENT_TEXT = {
  hit: (id, e) => `${id} hit Jev — ${e.health > 0 ? lives(e.health) : 'no lives left'}`,
  spotted: (id) => `${id} spotted Jev and gives chase`,
  lost_sight: (id) => `${id} lost sight of Jev and is searching`,
  gave_up: (id) => `${id} gave up the search`,
  caught: (id) => `${id} caught Jev`,
  blocked: (id) => `Shield blocked ${id}'s claw`,
  dispelled: (id) => `Jev dispelled ${id}`,
  cleared: () => 'Every adversary is gone: Jev wins',
  struck: (id, e) => {
    const lv = Number(game?.adversaries?.find((a) => a.id === id)?.level);
    return `Jev struck ${id}${lv > 0 ? ` (level ${lv})` : ''}${Number.isFinite(e.hp) ? ` (${e.hp} hp left)` : ''}`;
  },
  bump: (id) => `${id} bumped Jev`,
  coin_drop: (id) => `${id} dropped a coin`,
  heart: () => 'Jev picked up a heart: one life back',
  regen: (id, e) => `Jev healed a little — ${lives(e.health)}`,
  coin: (id, e) => `Jev picked up a coin${Number.isFinite(e.total) ? ` (${e.total})` : ''}`,
  alerted: (id, e) => `${id} heard ${e.by}'s call and joins the hunt`,
  brain_on: (id, e) => `${id} brain on${e.reason ? `: ${e.reason}` : ''}`,
  brain_off: (id, e) => `${id} brain off${e.reason ? `: ${e.reason}` : ''}`,
};

// ---------- adversary brains (spectator debug view: lists every adversary) ----------

// 4 tiny bars (up/down/left/right), the chosen one highlighted. Missing = not a legal move.
function miniBars(probs, chosen) {
  const wrap = el('div', null, 'adv-bars');
  for (const dir of DIR_ORDER) {
    const p = probs?.[dir];
    const cell = el('span', null, `adv-bar${dir === chosen ? ' chosen' : ''}${p == null ? ' off' : ''}`);
    cell.title = `${dir}: ${p == null ? 'not legal' : `${Math.round(p * 100)}%`}`;
    const fill = el('i');
    fill.style.height = `${Math.round((p ?? 0) * 100)}%`;
    cell.append(fill, el('b', dir[0].toUpperCase()));
    wrap.append(cell);
  }
  return wrap;
}

function adversaryCard(ad) {
  const br = ad.brain ?? null;
  const on = !!br?.on;
  const t = advTurns.get(ad.id);
  const card = el('div', null, `adv-card${on ? ' on' : ''}`);

  const head = el('div', null, 'adv-head');
  head.append(
    el('b', ad.id, 'adv-id'),
    el('span', br ? (on ? 'brain on' : 'brain off') : 'no brain data', `chip ${on ? 'brain' : 'off'}`),
    el('span', ad.mode, `adv-mode ${ad.mode}`),
  );
  if (ad.visible) head.append(el('span', 'in sight', 'adv-seen'));
  card.append(head);

  if (on) {
    card.append(el('div', `approach: ${br.approach ?? '—'}`, 'adv-line'));
    const act = br.latest_action ?? (t?.decision ? { choice: t.dir, ...t.decision } : null);
    if (act) {
      const row = el('div', null, 'adv-decision');
      // Forced moves (one legal way, or a step that catches) carry no probabilities.
      row.append(miniBars(act.probabilities ?? (act.choice ? { [act.choice]: 1 } : null), act.choice));
      const conf = act.confidence != null ? ` (${Number(act.confidence).toFixed(2)})` : act.probabilities ? '' : ' forced';
      row.append(el('span', `${act.choice ?? '—'}${conf}`, 'adv-choice'));
      card.append(row);
    } else {
      card.append(el('div', 'no decision yet', 'adv-line muted'));
    }
  } else {
    card.append(el('div', 'patrolling (no Jev)', 'adv-line muted'));
  }

  const extra = [];
  if (t?.keep_hunting != null) extra.push(`keep_hunting ${Number(t.keep_hunting).toFixed(2)}`);
  if (t?.apiMs) extra.push(`${Math.round(t.apiMs)} ms`);
  if (extra.length) card.append(el('div', extra.join(' · '), `adv-line${t.keep_hunting != null && t.keep_hunting < .5 ? ' warn' : ''}`));
  if (t?.error) card.append(el('div', `Jev error: ${t.error}`, 'adv-line warn'));
  if (br?.last_reason) card.append(el('div', br.last_reason, 'adv-reason'));
  return card;
}

function renderAdversaries() {
  const list = [...(game?.adversaries ?? [])].sort((p, q) =>
    (q.brain?.on ? 1 : 0) - (p.brain?.on ? 1 : 0) || p.id.localeCompare(q.id, undefined, { numeric: true }));
  const onCount = list.filter((a) => a.brain?.on).length;
  $('adv-count').textContent = list.length ? `${onCount}/${list.length} on` : '';
  $('adversaries').replaceChildren(...(list.length ? list.map(adversaryCard) : [el('p', '—', 'muted')]));
}

// 'strike' { id, cells, result }: id is the striker ('explorer' or a ghost id). An explorer strike
// that lands is logged by its own 'struck' / 'dispelled' event (which names the ghost), so only
// a miss, a block or protection gets a strike line here.
const isExplorerId = (id) => id === 'explorer' || id === '@' || id === 'jev' || id === 'Jev';
function strikeText(e, turn) {
  const miss = e.result === 'miss';
  if (isExplorerId(e.id)) {
    if (e.result === 'hit' || e.result === 'dispelled') return null;
    return miss ? 'Jev struck and missed' : `Jev struck (${e.result ?? 'no effect'})`;
  }
  // A blocked ghost strike already has its own "Shield blocked" line.
  if ((turn.events ?? []).some((x) => x.type === 'blocked' && x.id === e.id)) return null;
  return `${e.id} struck Jev${miss ? ' and missed' : e.result === 'protected' || e.result === 'blocked' ? ` (${e.result})` : ''}`;
}

function logEvents(turn) {
  for (const e of turn.events ?? []) {
    if (e.type === 'dispelled') renderer.forgetActor(e.id); // snap: no tween
    const text = e.type === 'strike' ? strikeText(e, turn) : (EVENT_TEXT[e.type] ?? ((id) => `${id}: ${e.type}`))(e.id, e);
    shout(e.id, e.type);
    if (text == null) continue;
    eventLog.unshift({ step: turn.step ?? game.steps, text: Array.isArray(e.at) && e.type !== 'struck' ? `${text} at (${e.at.join(',')})` : text, type: e.type });
  }
  eventLog.length = Math.min(eventLog.length, LOG_MAX);
  if ((turn.events ?? []).some((e) => e.type === 'hit')) flashHit();
  if ((turn.events ?? []).some((e) => e.type === 'coin')) renderer.noteCoin();
}

// Brief red flash over the board when Jev loses a life (restarts the CSS animation).

function flashHit() {
  const wrap = $('board-wrap');
  wrap.classList.remove('hit');
  void wrap.offsetWidth;
  wrap.classList.add('hit');
}

// v4 reuses turn.decision for the approach decision ({ trigger, sentiment, tactic, apiMs }).
// Before v4 it was the move decision ({ choice, probabilities, confidence, options }).
// Tell them apart by `trigger`; the move decision then lives under another name, if any.
function splitDecisions(turn) {
  const d = turn.decision ?? null;
  const approach = d?.trigger ? d : null;
  const legacy = d && !d.trigger ? d : null;
  const move = turn.move_decision ?? turn.move ?? legacy ?? null;
  return { approach, move };
}

function noteDecision(turn, d) {
  const tacticId = d.tactic?.choice ?? memory?.approach?.id ?? null;
  lastDecision = { ...d, step: turn.step ?? game.steps, tacticId };
  const senti = d.sentiment?.choice;
  eventLog.unshift({ step: lastDecision.step, text: `Decided: ${label(tacticId)}${senti ? ` (${label(senti)})` : ''}`, type: 'decision' });
}

function renderTurn(turn) {
  const { approach, move } = splitDecisions(turn);
  // The decision is made before the move, so its log line goes under this tick's events.
  if (approach) noteDecision(turn, approach);
  logEvents(turn);
  $('move-panel').hidden = false;
  const probs = move?.probabilities ?? { [turn.dir]: 1 };
  $('forced').hidden = !turn.forced;
  $('probs').replaceChildren(...EXPLORER_MOVES.flatMap((dir) => {
    const p = probs[dir];
    const chosen = dir === turn.dir;
    const off = p == null ? ' off' : '';
    const bar = el('span', null, `bar${chosen ? ' chosen' : ''}${off}`);
    bar.append(el('i'));
    bar.firstChild.style.width = `${Math.round((p ?? 0) * 100)}%`;
    return [
      el('span', dir, `${chosen ? 'chosen' : ''}${off}`),
      bar,
      el('span', p == null ? '—' : `${Math.round(p * 100)}%`, `num${off}`),
    ];
  }));
  const note = turn.forced
    ? `Step ${turn.step}: only one way to go, so no Jev call.`
    : `Step ${turn.step}: Jev chose ${turn.dir}` +
      (move?.confidence != null ? ` (confidence ${Number(move.confidence).toFixed(2)})` : '') +
      `, revealing ${turn.revealed} cell${turn.revealed === 1 ? '' : 's'}.`;
  $('move-note').textContent = note;
  // Hover on the bars shows what Jev was told about each move.
  if (move?.options) {
    $('probs').title = DIR_ORDER.filter((d) => move.options[d])
      .map((d) => `${d}: ${move.options[d]}`).join('\n');
  } else {
    $('probs').removeAttribute('title');
  }

  lastConfidence = turn.confidence ?? null;
  noteDirective(turn.directive ?? null, turn.step);
  const sd = turn.skill_decision;
  lastSkillDecision = sd && typeof sd === 'object' ? { ...sd, step: turn.step } : null; // this turn's only
  if (turn.review) lastReview = { ...turn.review, step: turn.step };
  if (!turn.forced && turn.apiMs != null) lastLatency = Math.round(turn.apiMs);
  // Adversary calls run in parallel, so the tick waits for the slowest one.
  advTurns = new Map((turn.adversaryTurns ?? []).map((a) => [a.id, a]));
  const calls = (turn.adversaryTurns ?? []).filter((a) => a.apiMs > 0).map((a) => a.apiMs);
  advLatency = calls.length ? Math.round(Math.max(...calls)) : null;
}

function renderReview() {
  const r = lastReview;
  if (!r) {
    $('review').textContent = 'No review yet.';
    $('review').className = 'muted';
    return;
  }
  const working = typeof r.working === 'number' ? r.working.toFixed(2) : '—';
  let text = `Step ${r.step}: approach working = ${working}.`;
  if (r.switched) text += ` Switched from ${r.from} to ${r.to}${r.reason ? `: ${r.reason}` : ''}.`;
  else text += ' Kept the current approach.';
  $('review').textContent = text;
  $('review').className = '';
}

function resetPane() {
  lastConfidence = null;
  lastReview = null;
  lastDecision = null;
  lastSkillDecision = null;
  lastLatency = null;
  advTurns = new Map();
  advLatency = null;
  approachesUsed = new Set();
  eventLog = [];
  routeKey = ''; cueText = null; // a new game: the cue run starts over
  directive = game?.directive ?? null;
  renderWhisper();
  $('probs').replaceChildren();
  $('probs').removeAttribute('title');
  $('forced').hidden = true;
  $('move-note').textContent = '';
  // No turn yet this session (new game or page reload): the panel stays hidden, unless the memory
  // still knows the last direction, which is all it can show without that turn's probabilities.
  const lastDir = Array.isArray(memory?.recent?.moves) ? memory.recent.moves.at(-1) : null;
  $('move-panel').hidden = !lastDir;
  if (lastDir) $('move-note').textContent = `Last direction: ${lastDir}. Jev's odds appear after the next step.`;
  renderReview();
}

function renderButtons() {
  $('start').disabled = !game || !!game.over;
  $('start').textContent = running ? 'Pause' : game?.steps ? 'Resume' : 'Start';
}

// ---------- game flow ----------

function loadGame(data) {
  game = data.game;
  memory = data.memory;
  elapsed = 0;
  resetPane();
  renderer.setView(game, { reset: true });
  clearThoughts();
  // A fresh game: the explorer's opening approach is its first thought, shown on the first step.
  updateThoughts(true);
  if (!game.steps && thoughts.has('@')) thoughts.get('@').key = null;
  renderMemory();
  renderButtons();
}

// One step at a time: ask, render, wait the delay, repeat while running.
async function loop() {
  if (looping) return;
  looping = true;
  try {
    while (running) {
      const myEpoch = epoch;
      let res;
      try {
        res = await api('POST', '/api/step');
      } catch (err) {
        res = { ok: false, status: 0, data: { error: err.message } };
      }
      if (myEpoch !== epoch) continue; // a Reload happened meanwhile; drop it

      if (!res.ok) {
        if (res.status === 409 && game?.over) break;
        pause();
        setStatus(`Step failed: ${res.data.error || `HTTP ${res.status}`}. Press Resume to retry.`, true);
        break;
      }

      // A fire strike is called out first: the shout shows on the board as it was before the step (the enemies still
      // standing), then the step lands and the blast plays.
      if (res.data.turn?.skill_decision?.used === 'fire_strike') {
        explorerShout(FIRE_SHOUT);
        await sleep(FIRE_CALL_MS);
        if (myEpoch !== epoch) continue;
      }
      game = res.data.game;
      memory = res.data.memory;
      renderTurn(res.data.turn);
      renderMemory();
      renderReview();
      renderer.setView(game, { dash: res.data.turn?.skill_decision?.used === 'dash' });
      if (res.data.turn?.skill_decision?.used === 'dash') explorerShout('Dash!', DASH_MS + 400);
      updateThoughts();
      if (game.over) {
        endGame();
        break;
      }
      if (running) setStatus('Jev is exploring…');
      await sleep(delayMs());
    }
  } finally {
    looping = false;
    renderButtons();
  }
}

function resume() {
  if (!game || game.over || running) return;
  running = true;
  resumedAt = performance.now();
  setStatus('Jev is exploring…');
  renderButtons();
  loop();
}

function pause() {
  if (!running) return;
  elapsed = playTime();
  running = false;
  setStatus('Paused.');
  renderButtons();
}

function endGame() {
  elapsed = playTime();
  running = false;
  renderButtons();
  const lost = !!game.lost;
  const cleared = !lost && game.won_by === 'cleared';
  setStatus(lost
    ? `Jev lost all lives after ${game.steps} steps.`
    : cleared ? `Jev dispelled every adversary in ${game.steps} steps.`
      : `Jev left through the portal with ${game.coins ?? 0} coin${game.coins === 1 ? '' : 's'} in ${game.steps} steps.`);
  $('over-title').textContent = lost ? 'Jev lost all lives' : cleared ? 'Dungeon cleared' : 'Jev escaped';
  $('overlay').querySelector('.modal').classList.toggle('lost', lost);
  const stats = {
    Steps: game.steps,
    Explored: `${Math.round(game.explored_pct)}%`,
    'Approaches used': approachesUsed.size,
    Time: formatTime(elapsed),
  };
  $('stats').replaceChildren(...Object.entries(stats).flatMap(([k, v]) => [el('dt', k), el('dd', String(v))]));
  $('overlay').classList.add('open');
}

async function reload() {
  epoch++;
  cooldownUntil = 0;
  loadWhisperSettings();
  running = false;
  $('overlay').classList.remove('open');
  setStatus('Generating a new dungeon…');
  let res;
  try {
    res = await api('POST', '/api/new');
  } catch (err) {
    res = { ok: false, data: { error: err.message } };
  }
  if (!res.ok) return setStatus(`Could not start a new game: ${res.data.error || `HTTP ${res.status}`}`, true);
  loadGame(res.data);
  resume();
}

// Timing constants and bubble lines from the central config (ui.* in central-config.yaml), served at api/ui. Defaults above
// and in thoughts.js stand if the call fails. Visual only.
async function loadUi() {
  try {
    const r = await fetch('api/ui');
    if (!r.ok) return;
    const ui = await r.json();
    const c = ui.constants ?? {};
    const num = (v, cur) => (Number.isFinite(v) ? v : cur);
    configureRenderer(c); // camMs, fadeMs, tweenMs, bobMs, animMs, walkMs, strikeMs, slashMs, fireMs, revealAlpha, blinkMs, coinGlowMs
    LOG_MAX = num(c.logMax, LOG_MAX); FIRE_MS = num(c.fireMs, FIRE_MS); FIRE_CALL_MS = num(c.fireCallMs, FIRE_CALL_MS);
    BUBBLE_IN = num(c.bubbleIn, BUBBLE_IN); BUBBLE_OUT = num(c.bubbleOut, BUBBLE_OUT);
    // The step delay is the slider's starting value; the player can still move it.
    if (Number.isFinite(c.stepDelayMs)) { $('delay').value = c.stepDelayMs; $('delay-value').textContent = `${delayMs()} ms`; }
    for (const [pool, target] of [['approach', THOUGHTS], ['mood', MOOD_THOUGHTS], ['troll', TROLL_THOUGHTS], ['tree_giant', TREE_GIANT_THOUGHTS], ['wolf', WOLF_THOUGHTS]]) Object.assign(target, ui.thoughts?.[pool] ?? {});
  } catch { /* keep the defaults */ }
}

// Provider changes apply live to this arena, including both explorer and adversaries.
const modelSelect = $('decision-model');
let selectedModel = null;

function modelStatus(text, isError = false) {
  $('model-status').textContent = text;
  $('model-status').classList.toggle('error', isError);
}

async function loadModels() {
  try {
    const response = await fetch('api/config');
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || `HTTP ${response.status}`);
    if (!['jev', 'laya', 'openai'].includes(config.values?.decisionProvider)) throw new Error('Restart this arena server to enable model selection.');
    selectedModel = config.values.decisionProvider;
    modelSelect.value = selectedModel;
    modelSelect.disabled = false;
    modelStatus('Changes apply immediately.');
  } catch (err) {
    modelStatus(`Models unavailable: ${err.message}`, true);
  }
}

modelSelect.addEventListener('change', async () => {
  const next = modelSelect.value;
  modelSelect.disabled = true;
  modelStatus('Switching model…');
  try {
    const response = await fetch('api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: { decisionProvider: next } }),
    });
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || `HTTP ${response.status}`);
    selectedModel = config.values.decisionProvider;
    modelSelect.value = selectedModel;
    modelStatus('Changes apply immediately.');
  } catch (err) {
    modelSelect.value = selectedModel;
    modelStatus(`Could not switch model: ${err.message}`, true);
  } finally {
    modelSelect.disabled = false;
  }
});

async function init() {
  await Promise.all([loadUi(), loadModels()]);
  let res = await api('GET', '/api/state');
  // A ?testbed URL always builds its arena; otherwise keep the server's game. No auto-start: page load costs no Jev calls.
  if (res.ok && (!res.data.game || TESTBED)) res = await api('POST', '/api/new');
  if (!res.ok) return setStatus(`Server error: ${res.data.error || `HTTP ${res.status}`}`, true);
  loadGame(res.data);
  if (game.over) {
    setStatus(`This game is already ${game.won ? 'won' : 'lost'}. Press Reload for a new dungeon.`);
  } else {
    setStatus(game.steps ? 'Press Resume to keep exploring.' : 'Press Start to let Jev explore.');
  }
}

// ---------- whisper (directive) ----------
// POST api/inject { text }: empty text clears. The server enforces the limits; the UI mirrors them.
const WHISPER_COOLDOWN_MS = () => whisperCooldownMs; // used after a success when the server names no retry time
const whisperInput = $('whisper-text');

function logWhisper(text, type = 'directive') {
  eventLog.unshift({ step: game?.steps ?? 0, text, type });
  eventLog.length = Math.min(eventLog.length, LOG_MAX);
  renderDanger();
}

function whisperMsg(text, isError = false) {
  $('whisper-msg').textContent = text;
  $('whisper-msg').hidden = !text;
  $('whisper-msg').classList.toggle('error', isError);
}

// Called with each turn's directive: a live one updates the countdown, a vanished one is logged as ended.
function noteDirective(next, step) {
  const prev = directive;
  directive = next;
  if (prev && !next && !game?.lost) logWhisper(`Directive ended: "${prev.text}"`);
  renderWhisper();
}

function renderWhisper() {
  const d = directive;
  $('whisper-live').hidden = !d;
  if (d) {
    $('whisper-live-text').textContent = `“${d.text}”`;
    const n = d.steps_left;
    $('whisper-left').textContent = Number.isFinite(n) ? `${n} step${n === 1 ? '' : 's'} left` : '';
  }
  const len = whisperInput.value.length;
  $('whisper-count').textContent = `${len}/${whisperInput.maxLength}`;
  $('whisper-count').classList.toggle('full', len >= whisperInput.maxLength);
  const left = cooldownUntil - performance.now();
  const dead = !game || !!game.over || whisperOff;
  whisperInput.disabled = dead;
  $('whisper-clear').disabled = dead;
  const btn = $('whisper-send');
  btn.disabled = dead || sendBusy || left > 0;
  btn.textContent = left > 0 ? `Wait ${Math.ceil(left / 1000)}s` : 'Send';
}
setInterval(renderWhisper, 250);

async function sendWhisper(text) {
  if (sendBusy) return;
  sendBusy = true;
  renderWhisper();
  const myEpoch = epoch;
  try {
    let res;
    try {
      const r = await fetch('api/inject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      res = { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
    } catch (err) {
      res = { ok: false, status: 0, data: { error: err.message } };
    }
    if (myEpoch !== epoch) return;
    if (res.ok) {
      const d = res.data.directive ?? null;
      const prev = directive;
      directive = d;
      if (d) {
        logWhisper(`Whispered: "${d.text}"`);
        whisperInput.value = '';
        whisperMsg(prev ? 'Replaced the earlier directive.' : 'Sent. Jev follows it from the next step.');
        cooldownUntil = performance.now() + WHISPER_COOLDOWN_MS();
      } else {
        if (prev) logWhisper('Directive cleared');
        whisperMsg(prev ? 'Cleared.' : 'Nothing to clear.');
      }
    } else if (res.status === 403) {
      whisperOff = true;
      whisperMsg(res.data.error || 'Player directives are switched off in the settings.', true);
    } else if (res.status === 429) {
      const ms = Number(res.data.retry_in_ms);
      cooldownUntil = performance.now() + (Number.isFinite(ms) ? ms : WHISPER_COOLDOWN_MS());
      whisperMsg(`Too soon: wait ${Math.ceil((cooldownUntil - performance.now()) / 1000)} s before the next whisper.`, true);
    } else if (res.status === 409) {
      whisperMsg(res.data.error || 'No game in progress, so nobody can hear you.', true);
    } else if (res.status === 400) {
      whisperMsg(res.data.error || 'That text was not accepted.', true);
    } else {
      whisperMsg(`Could not send: ${res.data.error || `HTTP ${res.status}`}`, true);
    }
  } finally {
    sendBusy = false;
    renderWhisper();
  }
}

// Mirror the Player settings (injectEnabled / injectMaxChars / injectCooldownS) from the existing settings endpoint.
async function loadWhisperSettings() {
  try {
    const r = await fetch('api/settings');
    const v = (await r.json()).values ?? {};
    whisperOff = v.injectEnabled === false;
    if (whisperOff) whisperMsg('Player directives are switched off in the settings.', true);
    if (Number.isFinite(v.injectMaxChars)) whisperInput.maxLength = v.injectMaxChars;
    if (Number.isFinite(v.injectCooldownS)) whisperCooldownMs = v.injectCooldownS * 1000;
  } catch { /* keep the defaults */ }
  renderWhisper();
}
loadWhisperSettings();

$('whisper').onsubmit = (e) => {
  e.preventDefault();
  const text = whisperInput.value.replace(/\s+/g, ' ').trim();
  if (!text) return whisperMsg('Type a short instruction first (Clear removes the live one).', true);
  if ($('whisper-send').disabled) return;
  sendWhisper(text);
};
whisperInput.oninput = () => { renderWhisper(); if ($('whisper-msg').classList.contains('error')) whisperMsg(''); };
$('whisper-clear').onclick = () => sendWhisper('');

$('start').onclick = () => (running ? pause() : resume());
$('reload').onclick = reload;
$('over-reload').onclick = reload;
$('close').onclick = () => $('overlay').classList.remove('open');
$('reveal').onchange = () => renderer.invalidateMinimap();
// The spine toggle needs no minimap rebuild: the polyline is drawn every frame.
$('delay').oninput = () => { $('delay-value').textContent = `${delayMs()} ms`; };

(function frame(now) {
  // Schedule first: one bad frame must not stop drawing for good (the step loop keeps going without it).
  requestAnimationFrame(frame);
  renderer.frame(now); // never throws: it logs a failed draw once
  try {
    syncRoute();
    drawBubbles(now);
  } catch (err) {
    if (!frame.warned) console.error('frame failed:', err);
    frame.warned = true;
  }
})(performance.now());

init().catch((err) => setStatus(`Could not reach the server: ${err.message}`, true));
