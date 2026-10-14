// The hosted player page (PLAN-multiplayer-impl.md WP-I, built against the "/v1 API contract"). One module drives
// `/` (name + Jev key, create a game) and `/g/<id>` (join form, lobby, running game, key prompt, spectator, end screen).
// Rules this file keeps: the Jev key lives only in a password field and in the body of a POST (never in storage, a URL
// or a log line; the field is emptied after every send); every request goes through api(); the board is drawn by the
// shared renderer from the fog-projected GameView the server sends and nothing else.
import { createRenderer, ready, SLOT_COLOURS } from '/render.js';

const $ = (id) => document.getElementById(id);
const roomId = location.pathname.match(/^\/g\/([\w-]+)\/?$/)?.[1] ?? null;
const VIEWS = ['entry', 'join', 'lobby', 'msg', 'game'];

// The one place that talks to the server. Returns { ok, status, data } and never throws on an HTTP error.
async function api(method, path, body) {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'network', message: 'Could not reach the server.' } };
  }
}

function show(name) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  document.body.classList.toggle('game', name === 'game');
  document.body.classList.toggle('page', name !== 'game');
}
let toastTimer = 0;
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function say(el, text) { el.textContent = text ?? ''; el.hidden = !text; }
const ERRORS = {
  game_started: 'That game has already started, so you cannot join it.',
  room_full: 'That room is full (4 knights).',
  not_found: 'No such room. It may have expired.',
  bad_name: 'Pick a name of 1-20 characters.',
  bad_key: 'A Jev key is required.',
  key_rejected: 'Jev rejected that key.',
  forfeited: 'You were removed from the game.',
  not_leader: 'Only the room leader can do that.',
};
const errText = (r) => ERRORS[r.data?.error] ?? r.data?.message ?? (r.status === 0 ? 'Could not reach the server.' : `Something went wrong (${r.status}).`);

const slotStyle = (slot) => {
  const c = SLOT_COLOURS[((Number(slot) | 0) % SLOT_COLOURS.length + SLOT_COLOURS.length) % SLOT_COLOURS.length];
  return `--c:${c.base};--cl:${c.light}`;
};
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'style') e.setAttribute('style', v); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  e.append(...kids.filter(Boolean));
  return e;
}

// ---------- state ----------
let lobby = null;       // latest GameSummary
let view = null;        // latest GameView
let selfId = null;
let renderer = null;
let es = null, pollTimer = 0, sseFails = 0;
let ended = false, endData = null;
let watching = false;   // the player closed the forfeit / end overlay
let keyDeadlineAt = null;
const mine = () => lobby?.participants?.find((p) => p.is_self) ?? null;

// ---------- entry ----------
function initEntry() {
  show('entry');
  $('entry-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const mode = ev.submitter?.dataset.mode ?? 'private';
    const btns = [...$('entry-form').querySelectorAll('button')];
    btns.forEach((b) => { b.disabled = true; });
    say($('entry-error'), '');
    const r = await api('POST', '/v1/games', { name: $('entry-name').value.trim(), key: $('entry-key').value, mode });
    $('entry-key').value = '';
    btns.forEach((b) => { b.disabled = false; });
    if (!r.ok) return say($('entry-error'), errText(r));
    location.assign(`/g/${r.data.game.id}`);
  });
}

// ---------- room ----------
async function initRoom() {
  const r = await api('GET', `/v1/games/${roomId}`);
  if (r.status === 404) return unavailable('Room not found', 'This room does not exist or has expired. Rooms are cleaned up after a while when nobody plays.');
  if (r.status === 403) return unavailable('You are not in this game', 'This game is not open for joining (it has started, or it belongs to other players). Start your own below.');
  if (!r.ok) return unavailable('Room unavailable', errText(r));
  if (r.data.game && !r.data.self) return initJoin(r.data.game);
  enterRoom(r.data);
}

function unavailable(title, text) {
  show('msg');
  $('msg-title').textContent = title; $('msg-text').textContent = text;
}

function initJoin(game) {
  show('join');
  lobby = game;
  if (game.status && game.status !== 'waiting') return unavailable(game.status === 'abandoned' ? 'Room expired' : 'Game already started', 'This room is no longer taking players.');
  $('join-roster').replaceChildren(...rosterRows(game, false));
  $('join-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('join-form').querySelector('button'); btn.disabled = true;
    say($('join-error'), '');
    const j = await api('POST', `/v1/games/${roomId}/join`, { name: $('join-name').value.trim(), key: $('join-key').value });
    $('join-key').value = ''; btn.disabled = false;
    if (!j.ok) {
      say($('join-error'), errText(j));
      if (j.data?.error === 'game_started' || j.data?.error === 'room_full') $('join-form').querySelector('button').disabled = true;
      return;
    }
    const g = await api('GET', `/v1/games/${roomId}`);
    if (g.ok) enterRoom(g.data); else location.reload();
  });
}

// A member opens the room: a lobby while waiting, the board otherwise. Both listen on the event stream.
function enterRoom(data) {
  view = data.tiles ? data : null;
  lobby = data.lobby ?? data.game ?? lobby;
  selfId = data.self ?? selfId;
  routeByStatus();
  connect();
}

function routeByStatus() {
  const st = lobby?.status;
  if (st === 'abandoned') return unavailable('Room expired', 'Nobody started this room in time, so it was closed.');
  if (st === 'waiting') { showLobby(); return; }
  if (!view) return; // the first GameView arrives on the stream / poll
  showGame();
}

// ---------- lobby ----------
function rosterRows(game, withSelf = true) {
  const rows = game.participants.map((p) => el('li', { class: p.is_self ? 'me' : '' },
    el('span', { class: 'swatch', style: slotStyle(p.slot), 'aria-hidden': 'true' }),
    el('span', { class: 'who', text: p.name }),
    p.is_self && withSelf ? el('span', { class: 'pill', text: 'you' }) : null,
    p.is_leader ? el('span', { class: 'pill leader', text: 'leader' }) : null,
    el('span', { class: `pill ${p.key_present ? 'ok' : 'warn'}`, text: p.key_present ? 'key ready' : 'no key' })));
  for (let i = game.participants.length; i < game.capacity; i++) rows.push(el('li', { class: 'empty' }, el('span', { class: 'swatch', style: '--c:transparent', 'aria-hidden': 'true' }), el('span', { class: 'who', text: 'Open slot' })));
  return rows;
}

function showLobby() {
  show('lobby');
  const g = lobby, me = mine();
  const n = g.participants.length;
  $('lobby-sub').textContent = g.mode === 'private' ? 'Solo game. Starting...' : 'Share the link, then the leader presses Start.';
  $('lobby-count').textContent = `${n}/${g.capacity}`;
  $('lobby-roster').replaceChildren(...rosterRows(g));
  $('lobby-link').value = `${location.origin}/g/${g.id}`;
  const lead = !!me?.is_leader;
  $('lobby-start').hidden = !lead;
  $('lobby-start').disabled = n < 1;
  $('lobby-wait').hidden = lead;
}
$('lobby-copy').addEventListener('click', async () => {
  const input = $('lobby-link');
  try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand?.('copy'); }
  toast('Link copied');
});
$('lobby-start').addEventListener('click', async () => {
  $('lobby-start').disabled = true; say($('lobby-error'), '');
  const r = await api('POST', `/v1/games/${roomId}/start`);
  $('lobby-start').disabled = false;
  if (!r.ok) return say($('lobby-error'), errText(r));
  lobby = r.data.game ?? lobby;
  await refetch();
});
$('lobby-leave').addEventListener('click', async () => { await api('POST', `/v1/games/${roomId}/leave`); location.assign('/'); });
$('leave-game').addEventListener('click', async () => {
  if (!confirm('Leave the game? Your knight forfeits.')) return;
  await api('POST', `/v1/games/${roomId}/leave`); location.assign('/');
});

async function refetch() {
  const r = await api('GET', `/v1/games/${roomId}`);
  if (!r.ok) return;
  if (r.data.tiles) view = r.data;
  lobby = r.data.lobby ?? lobby;
  selfId = r.data.self ?? selfId;
  routeByStatus();
  if (view) applyView();
}

// ---------- live updates: SSE with a polling fallback ----------
function setConn(text, cls) { const c = $('conn'); c.textContent = text; c.className = `chip ${cls}`; }
function connect() {
  if (es) es.close();
  es = new EventSource(`/v1/games/${roomId}/events`);
  es.onopen = () => { sseFails = 0; stopPolling(); setConn('live', 'safe'); };
  es.addEventListener('view', (m) => { view = JSON.parse(m.data); lobby = view.lobby ?? lobby; selfId = view.self ?? selfId; if ($('view-game').hidden) routeByStatus(); applyView(); });
  es.addEventListener('lobby', (m) => {
    lobby = JSON.parse(m.data);
    if (lobby.status !== 'waiting' && !view) { refetch(); return; }
    if (view) { view.lobby = lobby; renderTeam(); renderKeyState(); } else routeByStatus();
  });
  es.addEventListener('event', (m) => { try { logEvent(JSON.parse(m.data)); } catch { /* ignore a malformed event */ } });
  es.addEventListener('end', (m) => { try { endData = JSON.parse(m.data); } catch { endData = {}; } showEnd(); });
  es.onerror = () => {
    setConn('reconnecting', 'off');
    sseFails++;
    // EventSource retries by itself (and sends Last-Event-ID); when it gives up (CLOSED) or keeps failing, poll instead.
    if (es.readyState === EventSource.CLOSED || sseFails >= 3) startPolling();
  };
}
function startPolling() {
  if (pollTimer) return;
  setConn('polling', 'off');
  pollTimer = setInterval(refetch, 2000);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = 0; }

// ---------- game view ----------
let gameShown = false, lastViewStatus = null;
function showGame() {
  show('game');
  if (!renderer) {
    renderer = createRenderer($('board'), { wrap: $('board-wrap'), minimap: $('minimap'), reveal: () => false });
    ready.then(() => requestAnimationFrame(loop));
  }
}
function loop(now) {
  requestAnimationFrame(loop);
  if (!$('view-game').hidden) { renderer.frame(now); drawThoughts(now); }
}

const HEART_ROWS = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
function heartsSvg(hp, max) {
  const NS = 'http://www.w3.org/2000/svg';
  const out = [];
  for (let i = 0; i < max; i++) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 7 6');
    const part = Math.min(1, Math.max(0, hp - i));
    svg.setAttribute('class', part >= 1 ? 'full' : 'empty');
    HEART_ROWS.forEach((row, y) => [...row].forEach((c, x) => {
      if (c !== 'X') return;
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1); r.setAttribute('height', 1);
      if (part > 0 && part < 1 && x < Math.round(7 * part)) r.setAttribute('class', 'on');
      svg.append(r);
    }));
    out.push(svg);
  }
  return out;
}

const MOOD_COLOURS = { wary: '#ff9a6b', guarded: '#ffb86b', cautious: '#d9c26b', steady: '#7ee8ff', greedy: '#ffc633', bold: '#f5a42f', fearless: '#ff6a52', panic: '#ff4a3a' };
let thoughtsMod = null;
import('/thoughts.js').then((m) => { thoughtsMod = m; if (view) updateThoughts(); }).catch(() => {});

// One timed bubble per character, anchored to the renderer's moving head positions.
const bubbles = new Map();
const lastLines = new Map();
function updateThoughts() {
  if (!thoughtsMod) return;
  const pools = { troll: thoughtsMod.TROLL_THOUGHTS, tree_giant: thoughtsMod.TREE_GIANT_THOUGHTS, wolf: thoughtsMod.WOLF_THOUGHTS };
  const chars = (view.explorers ?? []).map((e) => ({
    id: e.self ? '@' : `e:${e.id}`, approach: e.thought?.id,
    since: e.thought?.since_step, text: e.thought?.thought, remark: e.thought?.remark, mood: e.thought?.mood, kind: 'explorer',
  }));
  for (const a of view.adversaries ?? []) if (a.visible && a.brain?.on) chars.push({
    id: a.id, approach: a.brain.approach, since: a.brain.approach_since,
    text: a.brain.approach_text, kind: 'adversary', voice: a.kind,
  });
  const present = new Set(chars.map((c) => c.id));
  for (const [id, t] of bubbles) if (!present.has(id)) { t.node.remove(); bubbles.delete(id); }
  for (const c of chars) {
    if (!c.approach) continue;
    const key = `${c.approach}@${c.since}`;
    let t = bubbles.get(c.id);
    const remark = c.remark && c.remark !== t?.remark ? c.remark : null;
    if (t?.key === key && !remark) { t.remark = c.remark; continue; }
    const pool = (c.mood && thoughtsMod.MOOD_THOUGHTS[c.mood]) || pools[c.voice]?.[c.approach] || thoughtsMod.THOUGHTS[c.approach];
    const fresh = pool?.filter((line) => line !== lastLines.get(c.id));
    const choices = fresh?.length ? fresh : pool;
    const text = remark || (choices?.length ? choices[Math.floor(Math.random() * choices.length)] : c.text);
    if (!text) continue;
    lastLines.set(c.id, text);
    if (!t) { t = { node: el('div', { class: `bubble ${c.kind}` }) }; bubbles.set(c.id, t); $('bubbles').append(t.node); }
    Object.assign(t, { key, remark: c.remark, t0: performance.now(), ms: Math.min(9000, Math.max(3500, 1200 + text.length * 50)) });
    t.node.replaceChildren(text);
    if (c.mood) { t.node.dataset.sentiment = c.mood; t.node.append(el('span', { class: 'senti-tag', text: c.mood })); }
    else delete t.node.dataset.sentiment;
  }
}
function drawThoughts(now) {
  const { S, dpr, viewW } = renderer.metrics(), scale = S / dpr, placed = [];
  for (const [id, t] of bubbles) {
    const head = renderer.heads.get(id), age = now - t.t0;
    const fade = Math.max(0, Math.min(1, age / 150, (t.ms - age) / 400));
    if (!head || !fade) { t.node.style.opacity = '0'; continue; }
    const w = t.node.offsetWidth, h = t.node.offsetHeight, hx = head.x * scale;
    const x = Math.max(6, Math.min(viewW - w - 6, hx - w / 2));
    let y = head.y * scale - 10 - h;
    for (const r of placed) if (x < r.x + r.w && r.x < x + w && y < r.y + r.h + 14 && r.y < y + h) y = Math.min(y, r.y - h - 14);
    y = Math.max(6, y); placed.push({ x, y, w, h });
    t.node.style.setProperty('--tail', `${Math.max(10, Math.min(w - 10, hx - x))}px`);
    t.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y + (1 - fade) * 4)}px)`;
    t.node.style.opacity = String(fade * head.alpha);
  }
}

function myExplorer() { return view?.explorers?.find((e) => e.self) ?? null; }
function isSpectator() {
  const st = mine()?.state;
  return view?.spectator === true || st === 'dead' || st === 'forfeited';
}

function applyView() {
  if (!view || !renderer) return;
  const first = !gameShown;
  gameShown = true;
  renderer.setView(view, first ? { reset: true } : {});
  const me = myExplorer();
  const health = me?.health ?? view.health ?? 0, max = me?.max_health ?? view.max_health ?? 0;
  $('hearts').replaceChildren(...(max ? heartsSvg(health, max) : ['—']));
  $('hearts').setAttribute('aria-label', `${health} of ${max} lives`);
  $('coins').textContent = me?.coins ?? view.coins ?? 0;
  $('steps').textContent = view.steps ?? 0;
  $('explored').textContent = `${Math.round(view.explored_pct ?? 0)}%`;
  updateThoughts();
  renderMind();
  renderTeam();
  renderBanners();
  renderWhisper();
  renderKeyState();
  if (view.over || lobby?.status === 'finished') {
    if (!ended) { endData ??= { result: view.result, ranking: Array.isArray(view.ranking) ? view.ranking : view.ranking?.ranking, team_score: view.team_score ?? view.ranking?.team_score }; showEnd(); }
  }
  if (!ended) setConn(es?.readyState === 1 ? 'live' : pollTimer ? 'polling' : 'reconnecting', es?.readyState === 1 ? 'safe' : 'off');
}

function renderMind() {
  const m = view.memory;
  const mood = m?.sentiment?.id;
  const chip = $('mood-chip');
  chip.textContent = mood ?? (isSpectator() ? 'watching' : '—');
  chip.style.setProperty('--senti', MOOD_COLOURS[mood] ?? 'var(--line-hi)');
  const a = m?.approach;
  $('approach-chip').textContent = a ? `${String(a.id).replaceAll('_', ' ')} · since step ${a.since_step}` : '';
  $('thought').textContent = a?.thought ? `"${a.thought}"` : (isSpectator() ? 'Your knight can no longer act.' : '');
}

function renderTeam() {
  const ex = view?.explorers ?? [];
  const byId = new Map((lobby?.participants ?? []).map((p) => [p.participant_id ?? p.name, p]));
  $('team-count').textContent = ex.length ? String(ex.length) : '';
  const STATUS = { active: 'active', awaiting_key: 'waiting for key', dead: 'down', forfeited: 'forfeited' };
  $('team').replaceChildren(...ex.map((e) => {
    const out = e.status === 'dead' || e.status === 'forfeited';
    const hearts = el('span', { class: 'hearts' });
    hearts.replaceChildren(...(out ? [] : heartsSvg(e.health, e.max_health)));
    const lead = lobby?.participants?.find((p) => p.name === e.name)?.is_leader;
    return el('li', { class: out ? 'out' : '' },
      el('span', { class: 'swatch', style: slotStyle(e.slot), 'aria-hidden': 'true' }),
      el('span', { class: 'who', text: e.name + (e.self ? ' (you)' : '') }),
      lead ? el('span', { class: 'pill leader', text: 'leader' }) : null,
      e.status === 'active' ? null : el('span', { class: `pill ${e.status === 'awaiting_key' ? 'warn' : ''}`, text: STATUS[e.status] ?? e.status }),
      hearts);
  }));
  void byId;
}

function renderBanners() {
  const spec = isSpectator();
  const st = mine()?.state;
  const b = $('spectator');
  b.hidden = !spec;
  if (spec) b.textContent = st === 'forfeited' ? 'Spectating: you forfeited. The board keeps updating.' : 'Spectating: your knight has fallen. You watch the team through its shared light.';
  $('board-wrap').classList.toggle('spectate', spec);
  const paused = lobby?.status === 'paused';
  $('paused').hidden = !paused;
  if (paused) $('paused').textContent = lobby.pause_reason === 'server_key' ? 'Paused: the server could not reach Jev. The host has been told.' : lobby.pause_reason === 'host' ? 'Paused by the host.' : 'Paused.';
  const priv = lobby?.mode === 'private';
  $('pause').hidden = !priv || spec || lobby?.status === 'finished';
  $('pause').textContent = paused ? 'Resume' : 'Pause';
  $('leave-game').hidden = lobby?.status === 'finished';
}
$('pause').addEventListener('click', async () => {
  const paused = lobby?.status === 'paused';
  const r = await api('POST', `/v1/games/${roomId}/${paused ? 'resume' : 'pause'}`);
  if (!r.ok) toast(errText(r)); else { lobby = r.data.game ?? lobby; renderBanners(); }
});

// ---------- events log ----------
const logLines = [];
const SKIP = new Set(['regen', 'bump', 'brain_on', 'brain_off', 'spotted', 'lost_sight', 'alerted', 'strike']);
function nameOf(id) { return view?.explorers?.find((e) => e.id === id || e.participant_id === id)?.name ?? lobby?.participants?.find((p) => p.participant_id === id)?.name ?? id; }
function lineOf(e) {
  if (e.text) return e.text;
  const who = nameOf(e.explorer ?? e.id);
  switch (e.type) {
    case 'help_called': return `${e.who ?? who} calls for help!`;
    case 'hit': return `${e.id} clawed ${nameOf(e.explorer ?? selfId) } (${e.health} left)`;
    case 'caught': return `${nameOf(e.explorer ?? selfId)} was caught`;
    case 'struck': return `${who} struck ${e.target ?? 'a monster'}`;
    case 'dispelled': return `${who ? `${who} dispelled ${e.target ?? e.monster ?? e.id}` : 'A monster was dispelled'}`;
    case 'coin': return `${who} picked up ${e.gained} coin${e.gained === 1 ? '' : 's'} (${e.total})`;
    case 'coin_drop': return 'A monster dropped a coin';
    case 'heart': return `${who} found a heart`;
    case 'blocked': return `${who} blocked a claw`;
    case 'cleared': case 'won': return 'The portal was reached!';
    default: return `${e.type.replaceAll('_', ' ')}`;
  }
}
function logEvent(e) {
  if (!e?.type || SKIP.has(e.type)) return;
  logLines.unshift({ type: e.type, text: lineOf(e), seq: e.seq });
  logLines.length = Math.min(logLines.length, 80);
  $('log').replaceChildren(...logLines.map((l) => el('li', { class: l.type }, el('span', { class: 't', text: l.seq != null ? `#${l.seq}` : '' }), l.text)));
}

// ---------- whisper ----------
let cooldownUntil = 0, directive = null, whisperTimer = 0;
const wText = $('whisper-text');
wText.addEventListener('input', () => { $('whisper-count').textContent = `${wText.value.length}/140`; updateSend(); });
function updateSend() { $('whisper-send').disabled = isSpectator() || performance.now() < cooldownUntil || wText.value.trim() === ''; }
function wMsg(text, err = false) { const m = $('whisper-msg'); m.textContent = text ?? ''; m.hidden = !text; m.classList.toggle('error', err); }
function renderWhisper() {
  directive = view?.directive ?? null;
  const off = isSpectator();
  wText.disabled = off;
  $('whisper').hidden = off && !directive;
  $('whisper-live').hidden = !directive;
  if (directive) {
    $('whisper-live-text').textContent = `"${directive.text}"`;
    $('whisper-left').textContent = directive.steps_left != null ? `${directive.steps_left} steps left` : '';
  }
  updateSend();
}
async function sendDirective(text) {
  $('whisper-send').disabled = true;
  const r = await api('POST', `/v1/games/${roomId}/directives`, { text });
  if (r.ok) {
    if (text) { wText.value = ''; $('whisper-count').textContent = '0/140'; wMsg('Whispered. Your knight will hear it on its next decision.'); } else wMsg('');
    if (r.data.directive !== undefined) { view.directive = r.data.directive; renderWhisper(); }
    cooldownUntil = performance.now() + 10000;
  } else if (r.status === 429) {
    const ms = r.data.retry_in_ms ?? 10000;
    cooldownUntil = performance.now() + ms;
    wMsg(`Not so fast: try again in ${Math.ceil(ms / 1000)} s.`, true);
  } else wMsg(errText(r), true);
  clearInterval(whisperTimer);
  whisperTimer = setInterval(() => { updateSend(); if (performance.now() >= cooldownUntil) clearInterval(whisperTimer); }, 500);
  updateSend();
}
$('whisper').addEventListener('submit', (ev) => { ev.preventDefault(); const t = wText.value.trim(); if (t) sendDirective(t); });
$('whisper-clear').addEventListener('click', () => sendDirective(''));

// ---------- key prompt ----------
let keyTimer = 0;
function renderKeyState() {
  const me = mine();
  const need = me?.state === 'awaiting_key';
  const forfeited = me?.state === 'forfeited' && !watching;
  $('key-overlay').classList.toggle('open', need);
  $('forfeit-overlay').classList.toggle('open', forfeited && !need);
  if (need) {
    if (me.key_deadline_ms_left != null) keyDeadlineAt = performance.now() + me.key_deadline_ms_left;
    else keyDeadlineAt = null;
    tickKey();
    if (!keyTimer) keyTimer = setInterval(tickKey, 500);
  } else { clearInterval(keyTimer); keyTimer = 0; }
}
function tickKey() {
  const t = $('key-timer');
  if (keyDeadlineAt == null) { t.hidden = true; return; }
  const s = Math.max(0, Math.ceil((keyDeadlineAt - performance.now()) / 1000));
  t.hidden = false;
  t.textContent = `Forfeit in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
$('key-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('key-form').querySelector('button'); btn.disabled = true;
  say($('key-error'), '');
  const r = await api('POST', `/v1/games/${roomId}/key`, { key: $('key-input').value });
  $('key-input').value = ''; btn.disabled = false;
  if (!r.ok) return say($('key-error'), errText(r));
  const me = mine();
  if (me && r.data.participant?.state) me.state = r.data.participant.state;
  renderKeyState();
  toast('Key accepted. Your knight moves again.');
});
$('forfeit-watch').addEventListener('click', () => { watching = true; renderKeyState(); });

// ---------- end screen ----------
function showEnd() {
  ended = true;
  const d = endData ?? {};
  const ranking = d.ranking ?? [];
  const won = d.result === 'won';
  $('end-title').textContent = won ? 'The team escaped' : 'The dungeon won';
  const score = d.team_score ?? ranking.reduce((s, r) => s + (r.points ?? 0), 0);
  $('end-sub').replaceChildren(document.createTextNode(won ? 'Someone stepped through the portal. ' : 'No knight is left standing. '), document.createTextNode('Team score '), el('b', { text: String(score) }), document.createTextNode('.'));
  const yes = (v) => el('span', { class: v ? 'yes' : 'no', text: v ? '✔' : '–' });
  $('end-table').tBodies[0].replaceChildren(...ranking.map((r, i) => el('tr', { class: `${r.participant_id === selfId ? 'me' : ''} ${r.forfeited ? 'forfeit' : ''}` },
    el('td', { text: String(i + 1) }),
    el('td', { class: 'l' }, el('span', { class: 'cell' }, el('span', { class: 'swatch', style: slotStyle(r.slot) }), el('span', { class: 'n', text: r.name }), r.forfeited ? el('span', { class: 'pill warn', text: 'forfeited' }) : null)),
    el('td', { text: String(r.coins) }), el('td', { text: String(r.strikes) }), el('td', { text: String(r.dispels) }),
    el('td', {}, yes(r.portal)), el('td', {}, yes(r.alive)), el('td', { class: 'pts', text: String(r.points) }))));
  $('end-overlay').classList.add('open');
  $('forfeit-overlay').classList.remove('open');
  $('key-overlay').classList.remove('open');
  if (es) es.close();
  stopPolling();
  setConn('finished', 'off');
}
$('end-close').addEventListener('click', () => $('end-overlay').classList.remove('open'));

// ---------- go ----------
if (roomId) initRoom(); else initEntry();
