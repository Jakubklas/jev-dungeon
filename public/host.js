// The host console (PLAN-multiplayer-impl.md WP-I, against the "/v1 API contract"): settings editor over the registry
// schema, the games list with pause / resume / end / reveal, a per-game Jev call log and the service counters.
// The one-time token arrives in the URL fragment (#token=...); it is posted to /v1/host/session and removed from the
// address bar at once. Every request goes through api().
import { createRenderer, ready, SLOT_COLOURS } from '/render.js';

const $ = (id) => document.getElementById(id);

async function api(method, path, body) {
  try {
    const res = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch { return { ok: false, status: 0, data: { message: 'Could not reach the service.' } }; }
}
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'style') e.setAttribute('style', v); else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  e.append(...kids.filter((k) => k != null && k !== false));
  return e;
}
const slotStyle = (slot) => { const c = SLOT_COLOURS[((Number(slot) | 0) % 4 + 4) % 4]; return `--c:${c.base};--cl:${c.light}`; };
const fmtTime = (v) => { const d = new Date(typeof v === 'number' && v < 1e11 ? v * 1000 : v); return Number.isNaN(+d) ? String(v) : d.toLocaleTimeString([], { hour12: false }); };

// ---------- session ----------
async function start() {
  const m = location.hash.match(/token=([^&]+)/);
  if (m) {
    const token = decodeURIComponent(m[1]);
    history.replaceState(null, '', location.pathname + location.search); // never leave the token in the address bar
    const r = await api('POST', '/v1/host/session', { token });
    if (!r.ok) return gate(r.data?.message ?? 'The host token was not accepted.');
  }
  const s = await api('GET', '/v1/host/settings');
  if (s.status === 403 || s.status === 401) return gate();
  if (!s.ok) return gate(s.data?.message ?? 'The service did not answer.');
  $('console').hidden = false;
  loadSettings(s.data);
  showTab(location.hash.slice(1) || 'settings');
  health(); setInterval(health, 5000);
}
function gate(text) { $('gate').hidden = false; if (text) $('gate-text').textContent = text; health(); }

async function health() {
  const r = await api('GET', '/health');
  const ok = r.ok && r.data.ok;
  $('health').className = `health ${ok ? 'ok' : 'bad'}`;
  $('health-text').textContent = ok ? `healthy · ${r.data.games ?? 0} games · up ${Math.round((r.data.uptime_s ?? 0) / 60)} min` : 'service not answering';
}

// ---------- tabs ----------
let tab = 'settings', refresh = 0;
function showTab(id) {
  if (!['settings', 'games', 'calls', 'metrics'].includes(id)) id = 'settings';
  tab = id;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
  for (const p of document.querySelectorAll('.pane-tab')) p.hidden = p.id !== `tab-${id}`;
  clearInterval(refresh); refresh = 0;
  if (id === 'games') { loadGames(); refresh = setInterval(loadGames, 5000); }
  if (id === 'calls') loadCalls();
  if (id === 'metrics') { loadMetrics(); refresh = setInterval(loadMetrics, 5000); }
}
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ---------- settings ----------
let schema = [], saved = {}, draft = {}, revision = 0, fieldErrors = {};
const dirty = () => schema.filter((s) => draft[s.key] !== saved[s.key]).map((s) => s.key);
function loadSettings(d) {
  schema = d.schema ?? []; saved = { ...d.values }; draft = { ...d.values }; revision = d.revision; fieldErrors = {};
  $('rev').textContent = `rules revision ${revision}`;
  renderSettings();
}
function renderSettings() {
  const q = $('filter').value.trim().toLowerCase();
  const form = $('form'); form.replaceChildren();
  let group = null;
  for (const s of schema) {
    if (q && !`${s.label} ${s.key} ${s.hint ?? ''} ${s.group}`.toLowerCase().includes(q)) continue;
    if (s.group !== group) { group = s.group; form.append(el('h2', { class: 'group', text: group })); }
    const row = el('div', { class: 'row', 'data-key': s.key });
    row.append(el('div', { class: 'name' }, s.label ?? s.key, s.when ? el('span', { class: `when ${s.when}`, text: s.when === 'live' ? 'live' : 'next game' }) : null), el('div', { class: 'hint', text: s.hint ?? '' }));
    const ctl = el('div', { class: 'ctl' });
    if (s.type === 'toggle') {
      const box = el('input', { type: 'checkbox' }); box.checked = !!draft[s.key];
      const word = el('span', { text: box.checked ? 'On' : 'Off' });
      box.addEventListener('change', () => { draft[s.key] = box.checked; word.textContent = box.checked ? 'On' : 'Off'; changed(); });
      ctl.append(el('label', { class: 'switch' }, box, word));
    } else if (s.type === 'range' || s.type === 'number') {
      const range = el('input', { type: 'range', min: s.min, max: s.max, step: s.step }), num = el('input', { type: 'number', min: s.min, max: s.max, step: s.step });
      range.value = num.value = draft[s.key];
      range.addEventListener('input', () => { num.value = range.value; draft[s.key] = Number(range.value); changed(); });
      num.addEventListener('input', () => { if (num.value === '' || Number.isNaN(Number(num.value))) return; draft[s.key] = Number(num.value); range.value = num.value; changed(); });
      ctl.append(range, num);
    } else if (s.type === 'select' && Array.isArray(s.options)) {
      const sel = el('select', {}, ...s.options.map((o) => el('option', { value: o, text: o })));
      sel.value = draft[s.key];
      sel.addEventListener('change', () => { draft[s.key] = sel.value; changed(); });
      ctl.append(sel);
    } else {
      const t = el('input', { type: 'text' }); t.value = draft[s.key] ?? '';
      t.addEventListener('input', () => { draft[s.key] = t.value; changed(); });
      ctl.append(t);
    }
    row.append(ctl);
    if (fieldErrors[s.key]) { row.classList.add('bad'); row.append(el('div', { class: 'ferr', text: fieldErrors[s.key] })); }
    form.append(row);
  }
  if (!form.children.length) form.append(el('p', { class: 'hint', text: 'No setting matches the filter.' }));
  changed();
}
function changed() {
  const d = dirty();
  for (const r of document.querySelectorAll('.row')) r.classList.toggle('changed', d.includes(r.dataset.key));
  $('save').disabled = !d.length; $('discard').disabled = !d.length;
  if (d.length) say(`${d.length} unsaved change${d.length === 1 ? '' : 's'}`);
}
function say(t, cls = '') { $('msg').textContent = t; $('msg').className = cls; }
$('filter').addEventListener('input', renderSettings);
$('discard').addEventListener('click', () => { draft = { ...saved }; fieldErrors = {}; renderSettings(); say(''); });
$('save').addEventListener('click', async () => {
  const values = Object.fromEntries(dirty().map((k) => [k, draft[k]])); // only what changed
  $('save').disabled = true;
  const r = await api('PUT', '/v1/host/settings', { values });
  if (r.ok) {
    saved = { ...r.data.values }; draft = { ...saved }; revision = r.data.revision; fieldErrors = {};
    $('rev').textContent = `rules revision ${revision}`;
    renderSettings();
    say(`Saved as revision ${revision} (${(r.data.changed ?? []).length} changed). New games use it.`, 'ok');
  } else {
    fieldErrors = r.data?.fields ?? {};
    renderSettings();
    say(r.status === 400 ? `Rejected: ${Object.keys(fieldErrors).length} field${Object.keys(fieldErrors).length === 1 ? '' : 's'} invalid.` : (r.data?.message ?? 'Save failed.'), 'err');
    document.querySelector('.row.bad')?.scrollIntoView({ block: 'center' });
  }
});
window.addEventListener('beforeunload', (e) => { if (dirty().length) e.preventDefault(); });

// ---------- games ----------
let gamesCache = [];
async function loadGames() {
  const r = await api('GET', '/v1/host/games');
  if (!r.ok) return;
  gamesCache = r.data.games ?? [];
  $('games-empty').hidden = gamesCache.length > 0;
  const body = $('games-table').tBodies[0];
  body.replaceChildren(...gamesCache.map((g) => {
    const c = g.calls ?? {};
    const act = (label, path, confirmText) => el('button', { type: 'button', text: label, onclick: async () => {
      if (confirmText && !confirm(confirmText)) return;
      const x = await api('POST', `/v1/host/games/${g.id}/${path}`);
      if (!x.ok) alert(x.data?.message ?? 'Failed'); else loadGames();
    } });
    const live = g.status === 'running' || g.status === 'paused';
    return el('tr', {},
      el('td', {}, el('code', { text: g.id })),
      el('td', {}, el('span', { class: `st ${g.status}`, text: g.status + (g.pause_reason ? ` (${g.pause_reason})` : '') })),
      el('td', { text: g.mode }),
      el('td', { class: 'people' }, ...(g.participants ?? []).map((p) => el('span', { class: 'p', title: p.state }, el('i', { class: 'sw', style: slotStyle(p.slot) }), p.name + (p.is_leader ? ' *' : '') + (p.state !== 'active' && p.state !== 'ready' ? ` (${p.state})` : '')))),
      el('td', { class: 'num', text: `r${g.rules_revision}` }),
      el('td', { class: 'num', title: 'posts / failures / timeouts / p50' }, `${c.posts ?? 0} / `, el('span', { class: c.failures ? 'bad' : '', text: String(c.failures ?? 0) }), ` / ${c.timeouts ?? 0} / ${c.p50_ms ?? '-'} ms`),
      el('td', { class: 'acts' },
        g.status === 'running' ? act('Pause', 'pause') : null, g.status === 'paused' ? act('Resume', 'resume') : null,
        live ? act('End', 'end', `End game ${g.id}?`) : null,
        g.status !== 'waiting' && g.status !== 'abandoned' ? el('button', { type: 'button', text: 'Reveal', onclick: () => reveal(g) }) : null,
        el('button', { type: 'button', text: 'Calls', onclick: () => { $('calls-game').dataset.pick = g.id; showTab('calls'); } })));
  }));
}

// A read-only board with the full map: the renderer with Reveal on, from the host's `view`.
let revealRenderer = null, revealRaf = 0;
async function reveal(g) {
  const r = await api('POST', `/v1/host/games/${g.id}/reveal`);
  if (!r.ok) return alert(r.data?.message ?? 'Could not reveal.');
  $('reveal').hidden = false;
  $('reveal-title').textContent = `Game ${g.id}: full map (read-only, logged as a host event)`;
  await ready;
  revealRenderer ??= createRenderer($('reveal-board'), { wrap: $('reveal-wrap'), minimap: $('reveal-mini'), reveal: () => true });
  revealRenderer.setView(r.data.view, { reset: true });
  const loop = (now) => { revealRaf = requestAnimationFrame(loop); revealRenderer.frame(now); };
  cancelAnimationFrame(revealRaf); revealRaf = requestAnimationFrame(loop);
}
$('reveal-close').addEventListener('click', () => { cancelAnimationFrame(revealRaf); $('reveal').hidden = true; });

// ---------- calls ----------
async function loadCalls() {
  const sel = $('calls-game');
  const r = await api('GET', '/v1/host/games');
  const list = r.ok ? r.data.games : gamesCache;
  const want = sel.dataset.pick || sel.value || list.find((g) => g.status === 'running')?.id;
  sel.replaceChildren(...list.map((g) => el('option', { value: g.id, text: `${g.id} (${g.status})` })));
  if (list.some((g) => g.id === want)) sel.value = want;
  delete sel.dataset.pick;
  if (!sel.value) { $('calls-table').tHead.replaceChildren(); $('calls-table').tBodies[0].replaceChildren(); $('calls-note').textContent = 'No games.'; return; }
  const c = await api('GET', `/v1/host/games/${sel.value}/calls?limit=200`);
  if (!c.ok) { $('calls-note').textContent = c.data?.message ?? 'Could not load the call log.'; return; }
  const calls = c.data.calls ?? [];
  $('calls-note').textContent = `${calls.length} most recent calls (keys and bodies are never logged)`;
  const cols = [];
  for (const row of calls.slice(0, 40)) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  $('calls-table').tHead.replaceChildren(el('tr', {}, ...cols.map((k) => el('th', { class: /ms|tick|status|count/.test(k) ? 'num' : '', text: k.replaceAll('_', ' ') }))));
  $('calls-table').tBodies[0].replaceChildren(...calls.map((row) => el('tr', {}, ...cols.map((k) => {
    const v = row[k];
    const cls = /ms|tick|count/.test(k) ? 'num' : '';
    if (k === 'ok') return el('td', { class: v ? 'ok' : 'bad', text: v ? 'ok' : 'fail' });
    return el('td', { class: cls, text: v == null ? '' : /^(at|ts|time)$/.test(k) ? fmtTime(v) : String(v) });
  }))));
}
$('calls-game').addEventListener('change', loadCalls);
$('calls-refresh').addEventListener('click', loadCalls);

// ---------- metrics ----------
const NICE = { posts: ['Jev POSTs', ''], failures: ['Failures', ''], timeouts: ['Timeouts', ''], latency_p50_ms: ['Latency p50', 'ms'], latency_p95_ms: ['Latency p95', 'ms'],
  actor_queue_delay_ms: ['Actor queue delay', 'ms'], event_write_delay_ms: ['Event write delay', 'ms'], sse_lag_ms: ['SSE lag', 'ms'], sse_clients: ['SSE clients', ''] };
async function loadMetrics() {
  const r = await api('GET', '/v1/host/metrics');
  if (!r.ok) { $('metrics-note').textContent = r.data?.message ?? 'Could not load metrics.'; return; }
  const flat = Object.entries(r.data).filter(([, v]) => typeof v === 'number' || typeof v === 'string');
  $('metrics').replaceChildren(...flat.map(([k, v]) => {
    const [label, unit] = NICE[k] ?? [k.replaceAll('_', ' '), ''];
    return el('div', { class: 'card' }, el('span', { text: label }), el('b', { text: typeof v === 'number' ? String(Math.round(v * 10) / 10) : v }), unit ? el('small', { text: unit }) : null);
  }));
  $('metrics-note').textContent = `Refreshes every 5 s. Last update ${new Date().toLocaleTimeString([], { hour12: false })}.`;
}

start();
