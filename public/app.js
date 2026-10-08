// Browser side: draws the dungeon and runs the step loop. All game logic and every
// Jev call live on the server; this file only asks for one step at a time.
const $ = (id) => document.getElementById(id);
const canvas = $('board');
const ctx = canvas.getContext('2d');

const CAM_MS = 120;       // camera easing time constant
const MINI_MAX = 180;     // longest minimap side in CSS pixels
const LOG_MAX = 12;       // event log length
const FADE_MS = 300;      // time for a cell to reach its new brightness
const DIR_ORDER = ['up', 'down', 'left', 'right'];
const EXPLORER_MOVES = [...DIR_ORDER, 'stay']; // the explorer can also stand still

let game = null;          // publicView from the server
let memory = null;
let shown = null;         // displayed brightness per cell, eased toward game.light
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
let strikeFx = null;      // this tick's attacks to flash: { t0, strikes } (S5), null when none
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

function formatTime(ms) {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
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

// ---------- look: isometric 8-bit ----------
// Everything is drawn in "art pixels" into a small offscreen buffer, which is then
// blitted to the board at an integer scale with smoothing off.

const TW = 32, TH = 16;           // tile diamond, art px
const HW = TW / 2, HH = TH / 2;
const WALL_H = 11;                // one wall block's height, art px
const MAX_BLOCKS = 2;             // a wall is 1..MAX_BLOCKS blocks tall (z dimension)
const TALL_WALL_SHARE = .25;      // share of walls that are MAX_BLOCKS tall; the rest are 1 block
const BANDS = 8;                  // light bands for known cells
const FOG_BANDS = 5;              // glow bands for unknown cells (distance 1..5 to known)
const FOG_PAD = FOG_BANDS;        // the glow may spill this far past the map edge
const FLOOR_VARIANTS = 6;
const TWEEN_MS = 150;             // entity move tween
const BOB_PX = 2, BOB_MS = 1600;  // ghost hover
const ANIM_MS = 260;              // idle animation frame time
const STRIKE_MS = 800;            // strike overlay: held at full strength, then fades (STRIKE_HOLD)
const STRIKE_HOLD = .5;           // share of STRIKE_MS before the fade starts
const STRIKE_COLOR = '#ff3a2c', BLOCK_COLOR = '#8fb4ff';
const SHIELD_SLASH_MS = 260;      // the parry crescent: 6 frames like the sword's slash, a little quicker
const SLASH_MS = 340;             // the slash crescent sweeps in the first part of STRIKE_MS, then is gone
// Slash palette, outer rim to bright core: the explorer's sword is white-blue, a ghost's claw red-white.
const SLASH_COLORS = {
  sword: ['#2a2392', '#5b4fe0', '#a9a4ff', '#ffffff'],
  claw: ['#6b0f12', '#c22a2a', '#ff8f80', '#fff1ea'],
  shield: ['#c98a14', '#ffc633', '#fff0a8', '#ffffff'], // the block spark: the coin gold ramp (the shield's face), rim to core
};
const FACE_X = { right: 1, up: 1, left: -1, down: -1 }; // server facing -> sprite side
const REVEAL_ALPHA = .42;         // cells and ghosts shown only because of "Reveal map"

// Known stone ramps from cold navy (light 0.2, the edge of what Jev has seen) through
// dusky stone to warm torchlit amber (light 1.0, where Jev walked). Three stops each.
const PALETTE = {
  void: '#04050d',
  floor:      ['#172547', '#463d61', '#bc7a34'],
  floorHi:    ['#1e3161', '#574b77', '#dd9f51'],
  floorLo:    ['#121e3c', '#373150', '#9d6225'],
  mortar:     ['#0a1126', '#211c33', '#5b3313'],
  wallTop:    ['#2a4478', '#675987', '#dda35a'],
  wallTopHi:  ['#3f5fa1', '#8976a6', '#facb82'],
  wallL:      ['#1a2a50', '#463959', '#975c2a'],
  wallR:      ['#101a38', '#2e263f', '#633a1a'],
  wallMortar: ['#080e21', '#191527', '#3b210b'],
  fog:        ['#0e1937', '#0b142c', '#090f22', '#060a19', '#050710'], // distance 1..5
  trail: '#ffd98c',
  explorer: '#ffe7b0', chest: '#ff9a1c', enemy: '#ff4a3a', shadow: 'rgba(0, 0, 0, .45)',
  brain: '#7ee8ff', brainEdge: '#082c36',   // "Jev brain on" marker above a ghost
};

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));
const css = (c) => `rgb(${c.join(',')})`;
// Colour of one material at band b (0 = cold .. BANDS-1 = warm).
function ramp(name, band) {
  const [c0, c1, c2] = PALETTE[name].map(hexRgb);
  const t = band / (BANDS - 1);
  return t < .5 ? mix(c0, c1, t * 2) : mix(c1, c2, (t - .5) * 2);
}
const bandOf = (light) => Math.max(0, Math.min(BANDS - 1, Math.round(((light - .2) / .8) * (BANDS - 1))));

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Deterministic per-cell noise.
function hash(x, y, s = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Pixel diamond, 32x16: row r spans 2(r+1) px each side of the centre (mirrored below).
const inDiamond = (px, py) => {
  const half = py < HH ? 2 * (py + 1) : 2 * (TH - py);
  return px >= HW - half && px < HW + half;
};
const bottomRow = (px) => HH + Math.floor((px < HW ? px : TW - 1 - px) / 2);

// Stone pattern as palette indices: 0 none, 1 mortar, 2 dark, 3 base, 4 light.
const MORTAR = 1, LO = 2, BASE = 3, HI = 4;
function stonePattern(kind, seed, rim = false) {
  const out = new Uint8Array(TW * TH);
  const n = [2, 3, 1][kind];               // flagstones 2x2, cobbles 3x3, one cracked slab
  const w = n / TH;                        // one pixel of mortar, in stone units
  for (let py = 0; py < TH; py++) {
    for (let px = 0; px < TW; px++) {
      if (!inDiamond(px, py)) continue;
      const sx = px + .5 - HW, sy = py + .5;
      const gx = sx / TW + sy / TH, gy = sy / TH - sx / TW;   // cell-local grid coords, 0..1
      let u = gx * n;
      const v = gy * n, row = Math.floor(v);
      if (kind === 1 && row % 2) u += .5;
      const fu = u - Math.floor(u), fv = v - row;
      const tone = hash(Math.floor(u), row, seed);
      let c;
      if (fu < w || fv < w) c = rim ? LO : MORTAR;
      else if (!rim && (fu < 2 * w || fv < 2 * w)) c = HI;
      else if (!rim && (fu > 1 - w || fv > 1 - w)) c = LO;
      else c = tone < .3 ? LO : tone > .82 && !rim ? HI : BASE;
      if (kind === 2 && c >= LO && Math.abs(fu - (.25 + .5 * fv)) < w * .8 && fv > .2 && fv < .8) c = MORTAR;
      if (c >= LO && hash(px, py, seed + 7) < (rim ? .04 : .06)) c = c === LO ? MORTAR : LO;
      if (rim) {
        // Wall caps: lit rim on the top edges, shade on the bottom edges.
        if (gx < 1 / TH * 1.5 || gy < 1 / TH * 1.5) c = HI;
        else if (gx > 1 - 1 / TH || gy > 1 - 1 / TH) c = LO;
      }
      out[py * TW + px] = c;
    }
  }
  return out;
}

function paint(target, pattern, cols, dy = 0) {
  const g = target.getContext('2d');
  const img = g.getImageData(0, dy, TW, TH);
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (!c) continue;
    const [r, gg, bb] = cols[c];
    img.data.set([r, gg, bb, 255], i * 4);
  }
  g.putImageData(img, 0, dy);
}

// Pre-rendered tiles: floors[band][variant], walls[band][top][blocks-1][mask], fogTiles[d-1].
// mask bit 1 = draw the left side face, bit 2 = the right one.
const floorPatterns = Array.from({ length: FLOOR_VARIANTS }, (_, i) => stonePattern(i % 3, 11 + i));
const capPatterns = [stonePattern(0, 51, true), stonePattern(1, 52, true)];
const floors = [], walls = [];
for (let band = 0; band < BANDS; band++) {
  const fc = [null, ramp('mortar', band), ramp('floorLo', band), ramp('floor', band), ramp('floorHi', band)];
  floors.push(floorPatterns.map((p) => {
    const c = makeCanvas(TW, TH);
    paint(c, p, fc);
    return c;
  }));
  const top = ramp('wallTop', band), mortar = ramp('wallMortar', band);
  const tc = [null, mortar, mix(top, ramp('wallL', band), .45), top, ramp('wallTopHi', band)];
  const faces = { L: ramp('wallL', band), R: ramp('wallR', band) };
  walls.push(capPatterns.map((cap, ci) => Array.from({ length: MAX_BLOCKS }, (_, hi) => [0, 1, 2, 3].map((mask) => {
    const nb = hi + 1;
    const c = makeCanvas(TW, TH + WALL_H * nb);
    const g = c.getContext('2d');
    for (let px = 0; px < TW; px++) {
      const left = px < HW;
      if (!(mask & (left ? 1 : 2))) continue;
      const face = faces[left ? 'L' : 'R'];
      const r0 = bottomRow(px) + 1, u = left ? px : TW - 1 - px;
      for (let k = 0; k < WALL_H * nb; k++) {
        // Each block is shaded on its own: blocks nearer the floor are a little darker.
        const blk = Math.floor(k / WALL_H), kk = k % WALL_H;
        const course = Math.floor(kk / 4), fb = mix(face, mortar, .1 * (nb - 1 - blk));
        let col = fb;
        if (kk % 4 === 3 || kk === WALL_H - 1 || (u + course * 3 + ci + blk * 2) % 6 === 0) col = mortar;
        else if (kk === 0) col = mix(fb, mortar, blk === 0 && nb === 1 ? .35 : .5);        // shade under a cap / block seam
        else if (hash(Math.floor((u + course * 3) / 6), course + blk * 5, ci + px * 0 + (left ? 3 : 4)) < .3) col = mix(fb, mortar, .25);
        else if (left && px === HW - 1) col = mix(fb, top, .3);               // front corner catches light
        g.fillStyle = css(col);
        g.fillRect(px, r0 + k, 1, 1);
      }
    }
    paint(c, cap, tc);
    return c;
  }))));
}
const fogTiles = PALETTE.fog.map((hex) => {
  const c = makeCanvas(TW, TH);
  const g = c.getContext('2d');
  const base = hexRgb(hex), edge = mix(base, hexRgb(PALETTE.void), .35);
  for (let py = 0; py < TH; py++) {
    for (let px = 0; px < TW; px++) {
      if (!inDiamond(px, py)) continue;
      const sx = px + .5 - HW, sy = py + .5;
      const gx = sx / TW + sy / TH, gy = sy / TH - sx / TW;
      g.fillStyle = css(gx < 1 / TH || gy < 1 / TH ? edge : base);
      g.fillRect(px, py, 1, 1);
    }
  }
  return c;
});

// ---------- sprites ----------
// sprites.js (pixel art) is loaded dynamically; until it loads, or if it fails, simple
// drawn stand-ins with the same shape are used: { canvas, w, h, anchorX, anchorY, frames? }.

function spriteFrom(w, h, anchorX, anchorY, rects) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  for (const [col, x, y, rw, rh] of rects) {
    g.fillStyle = col;
    g.fillRect(x, y, rw, rh);
  }
  return { canvas: c, w, h, anchorX, anchorY };
}
function fallbackSprites() {
  return {
    knight: spriteFrom(14, 22, 7, 21, [
      ['#bb1d1d', 6, 0, 3, 3], ['#c2c9dc', 3, 3, 9, 7], ['#161b2a', 8, 6, 4, 1],
      ['#a41616', 2, 10, 4, 9], ['#6d7ea4', 4, 10, 7, 8], ['#d5a533', 9, 11, 4, 6], ['#313851', 4, 18, 3, 3], ['#313851', 8, 18, 3, 3],
    ]),
    ghost: spriteFrom(14, 18, 7, 17, [
      ['#c3c9da', 3, 0, 8, 2], ['#c3c9da', 1, 2, 12, 11], ['#919bb8', 1, 13, 3, 3], ['#919bb8', 5, 13, 3, 4], ['#919bb8', 10, 13, 3, 3],
      ['#ff3030', 7, 5, 2, 2], ['#ff3030', 10, 5, 2, 2],
    ]),
    chest: spriteFrom(14, 11, 7, 9, [
      ['#723c15', 1, 1, 12, 9], ['#97551d', 1, 1, 12, 3], ['#ffc633', 1, 4, 12, 1], ['#ffc633', 6, 4, 2, 3],
    ]),
    coin: spriteFrom(7, 7, 3, 5, [
      ['#3a2406', 1, 0, 5, 7], ['#3a2406', 0, 2, 7, 3], ['#ffc633', 1, 2, 5, 3], ['#ffc633', 2, 1, 3, 5],
    ]),
  };
}
let sprites = fallbackSprites();
import('./sprites.js')
  .then((m) => {
    const got = m.buildSprites();
    for (const k of ['knight', 'ghost', 'chest', 'coin']) if (got?.[k]?.canvas) sprites[k] = got[k];
  })
  .catch((err) => console.warn('sprites.js unavailable, using stand-in shapes:', err));

const frameOf = (spr, now, phase = 0) =>
  spr.frames?.length ? spr.frames[Math.floor(now / ANIM_MS + phase) % spr.frames.length] : spr;

// ---------- props and wall decor (v4) ----------
// props/index.js rasterises the floor props and wall decor into banded sprites. Loaded like
// sprites.js: if it fails, the game runs without props. Each kind: floor[kind][band],
// wall[kind].L|R[band], meta[kind] = { frameMs, glow, w, h }.
let propArt = null;
import('./props/index.js')
  .then((m) => m.buildProps({ bands: BANDS, navy: hexRgb(PALETTE.floor[0]), tw: TW, th: TH, wallH: WALL_H, bottomRow }))
  .then((p) => { propArt = p; })
  .catch((err) => console.warn('props/index.js unavailable, drawing without props:', err));

// The view's props and decor, indexed once per new view (never per frame).
let solidProp = null;   // Uint8Array(W*H): 1 where a solid prop stands (tiles say '#' there)
let floorProps = [];    // game.props with .phase
let decorAt = new Map(); // y*W+x -> [decor] of that wall cell
const GLOW_COLOR = '#ffb458';
function indexProps() {
  const { width: W, height: H } = game;
  solidProp = new Uint8Array(W * H);
  floorProps = [];
  for (const p of game.props ?? []) {
    if (p.solid) solidProp[p.y * W + p.x] = 1;
    if (p.part) continue; // the other cells of a forge: solid, drawn by the anchor
    floorProps.push({ ...p, depth: p.x + p.y, phase: hash(p.x, p.y, 9) });
  }
  indexHeights();
  decorAt = new Map();
  for (const d of game.decor ?? []) {
    const k = d.y * W + d.x;
    (decorAt.get(k) ?? decorAt.set(k, []).get(k)).push({ ...d, phase: hash(d.x, d.y, 5), blocks: 1 + Math.floor(hash(d.x, d.y, (Number(game.seed) | 0) ^ 0x7b19) * 2) });
  }
}
const isSolidProp = (x, y) => solidProp[y * game.width + x] === 1;

// Wall height in blocks (1 or MAX_BLOCKS = 2, TALL_WALL_SHARE of the walls the tall one): a pure hash of cell + seed, so it never touches the
// game rng, gameplay or the server. Walls only: floors stay flat at z = 0.
let wallBlocks = new Uint8Array(0);
function indexHeights() {
  const { width: W, height: H } = game, sd = Number(game.seed) | 0;
  wallBlocks = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) wallBlocks[y * W + x] = hash(x, y, sd ^ 0x5a17) < TALL_WALL_SHARE ? MAX_BLOCKS : 1;
}
const blocksAt = (x, y) => wallBlocks[y * game.width + x];

// ---------- board, buffer, camera ----------

const buf = makeCanvas(1, 1);
const b = buf.getContext('2d');
let viewW = 0, viewH = 0, dpr = 1;
let S = 2; // device pixels per art pixel (integer)
function resizeBoard() {
  const wrap = $('board-wrap');
  dpr = window.devicePixelRatio || 1;
  viewW = wrap.clientWidth;
  viewH = wrap.clientHeight;
  canvas.width = Math.max(1, Math.round(viewW * dpr));
  canvas.height = Math.max(1, Math.round(viewH * dpr));
  const cssScale = viewW < 600 ? 1.5 : viewW > 1600 || viewH > 1100 ? 3 : 2;
  S = Math.max(1, Math.round(cssScale * dpr));
  buf.width = Math.ceil(canvas.width / S);
  buf.height = Math.ceil(canvas.height / S);
  ctx.imageSmoothingEnabled = false; // reset by every size change
  b.imageSmoothingEnabled = false;
  miniDirty = true;
}
new ResizeObserver(resizeBoard).observe($('board-wrap'));

// World art px of a (fractional) grid point. A cell's centre is (x+.5, y+.5).
const isoX = (gx, gy) => (gx - gy) * HW;
const isoY = (gx, gy) => (gx + gy) * HH;

// Characters, tweened in grid space. Keyed by adversary id, '@' for the explorer.
// face: 1 = right, -1 = left (mirrored), from the sign of the screen-x travel.
const actors = new Map();
function actorPos(a, now) {
  let k = Math.min(1, Math.max(0, (now - a.t0) / TWEEN_MS));
  k = k * k * (3 - 2 * k);
  return [a.from[0] + (a.to[0] - a.from[0]) * k, a.from[1] + (a.to[1] - a.from[1]) * k];
}
function moveActor(id, pos, now, snap) {
  const a = actors.get(id);
  if (!a) {
    actors.set(id, { from: [...pos], to: [...pos], t0: 0, face: 1 });
    return;
  }
  const dsx = (pos[0] - pos[1]) - (a.to[0] - a.to[1]);
  if (dsx) a.face = Math.sign(dsx);
  if (pos[0] === a.to[0] && pos[1] === a.to[1]) return;
  a.from = snap ? [...pos] : actorPos(a, now);
  a.to = [...pos];
  a.t0 = now;
}
// After each new view. A ghost that was not drawn last time, or jumped, snaps into place
// instead of streaking across the fog.
function syncActors(reset) {
  const now = performance.now();
  if (reset) actors.clear();
  moveActor('@', game.pos, now, false);
  if (FACE_X[game.facing]) actors.get('@').face = FACE_X[game.facing]; // server facing wins when present
  const ids = new Set();
  for (const ad of game.adversaries ?? []) {
    ids.add(ad.id);
    const prev = actors.get(ad.id);
    const jumped = prev && Math.abs(ad.pos[0] - prev.to[0]) + Math.abs(ad.pos[1] - prev.to[1]) > 1;
    moveActor(ad.id, ad.pos, now, !prev?.drawn || jumped);
    const act = actors.get(ad.id);
    act.drawn = ad.visible || revealOn();
    if (FACE_X[ad.facing]) act.face = FACE_X[ad.facing];
  }
  // A ghost that left the game (dispelled) is forgotten at once: no tween, no ghost frame.
  for (const id of [...actors.keys()]) if (id !== '@' && !ids.has(id)) actors.delete(id);
}

// Camera: world art px of the buffer's top-left. Centres on the (tweened) explorer.
const cam = { x: 0, y: 0 };
function cameraTarget() {
  const [gx, gy] = actorPos(actors.get('@'), performance.now());
  return { x: isoX(gx + .5, gy + .5) - buf.width / 2, y: isoY(gx + .5, gy + .5) - 10 - buf.height / 2 };
}
function snapCamera() {
  if (!game) return;
  Object.assign(cam, cameraTarget());
}
function moveCamera(dt) {
  if (!game) return;
  const t = cameraTarget();
  const k = 1 - Math.exp(-dt / CAM_MS);
  cam.x += (t.x - cam.x) * k;
  cam.y += (t.y - cam.y) * k;
  if (Math.abs(t.x - cam.x) < .3) cam.x = t.x;
  if (Math.abs(t.y - cam.y) < .3) cam.y = t.y;
}

// Culling: on-screen cells by diagonal. Diagonal d = x+y sets the screen row
// (sy = d*HH), and e = x-y the screen column (sx = e*HW). Padded for wall and sprite height.
function viewBounds(cx, cy) {
  return {
    dMin: Math.floor(cy / HH) - 2,
    dMax: Math.ceil((cy + buf.height) / HH) + Math.ceil(MAX_BLOCKS * WALL_H / HH) + 2, // a tall wall's top reaches up into view
    eMin: Math.floor(cx / HW) - 2,
    eMax: Math.ceil((cx + buf.width) / HW) + 2,
  };
}
// e range on diagonal d within the cell box [lo, hiX) x [lo, hiY), parity-matched to d.
function eRange(v, d, lo, hiX, hiY) {
  let e0 = Math.max(v.eMin, 2 * lo - d, d - 2 * (hiY - 1));
  const e1 = Math.min(v.eMax, 2 * (hiX - 1) - d, d - 2 * lo);
  if ((e0 + d) & 1) e0++;
  return [e0, e1];
}

// Distance from each cell to the nearest known cell (8-way BFS, capped), on a grid padded by
// FOG_PAD. Recomputed only when a new view arrives. Uses light only, never tiles.
let fog = null, fogW = 0;
function computeFog() {
  const P = FOG_PAD, W = game.width + 2 * P, H = game.height + 2 * P;
  fogW = W;
  fog = new Uint8Array(W * H).fill(255);
  const queue = new Int32Array(W * H);
  let qh = 0, qt = 0;
  for (let y = 0; y < game.height; y++) {
    for (let x = 0; x < game.width; x++) {
      if (game.light[y][x] > 0) {
        const i = (y + P) * W + x + P;
        fog[i] = 0;
        queue[qt++] = i;
      }
    }
  }
  while (qh < qt) {
    const i = queue[qh++], d = fog[i] + 1;
    if (d > FOG_BANDS) continue;
    const x = i % W, y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (fog[j] > d) {
          fog[j] = d;
          queue[qt++] = j;
        }
      }
    }
  }
}

// Coin piles from the view as [x, y, count] per distinct cell (older servers send none).
function coinCells() {
  const m = new Map();
  for (const c of game?.coin_piles ?? []) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const k = `${c[0]},${c[1]}`;
    const e = m.get(k);
    if (e) e[2]++; else m.set(k, [c[0], c[1], 1]);
  }
  return [...m.values()].filter(([x, y]) => game.light[y]?.[x] !== undefined);
}

function resetBoard() {
  shown = game.light.map((row) => row.map(() => 0));
  miniDirty = true;
  computeFog();
  indexProps();
  syncActors(true);
  strikeFx = null;
  snapCamera();
}

// A new view arrived (a step): refresh everything derived from it.
function boardUpdate() {
  miniDirty = true; // also covers coin_piles changes: the minimap redraws whenever a view arrives
  computeFog();
  indexProps();
  syncActors(false);
  // Only a view that arrives from a step flashes its strikes (a page load does not replay them). A view
  // without strikes leaves a running flash alone, so fast steps don't cut it short.
  if (Array.isArray(game.strikes) && game.strikes.length) strikeFx = { t0: performance.now(), strikes: game.strikes };
}

// Ease displayed brightness toward the real light, for on-screen cells only.
function easeLight(dt) {
  if (!game || !shown) return;
  const stepBy = dt / FADE_MS;
  const v = viewBounds(Math.round(cam.x), Math.round(cam.y));
  for (let d = v.dMin; d <= v.dMax; d++) {
    const [e0, e1] = eRange(v, d, 0, game.width, game.height);
    for (let e = e0; e <= e1; e += 2) {
      const x = (d + e) >> 1, y = (d - e) >> 1;
      const target = game.light[y][x], cur = shown[y][x];
      if (cur === target) continue;
      shown[y][x] = cur < target ? Math.min(target, cur + stepBy) : Math.max(target, cur - stepBy);
    }
  }
}

// Adversaries the board may draw: visible ones, or all of them (dimmed) with Reveal map.
function drawnAdversaries() {
  const reveal = revealOn();
  return (game.adversaries ?? []).filter((a) => a.visible || reveal);
}

// Crisp filled ellipse in art px (row by row, no antialiasing).
function pixelEllipse(cx, cy, rx, ry) {
  for (let dy = -ry; dy <= ry; dy++) {
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / (ry + .5)) ** 2)));
    if (half > 0) b.fillRect(cx - half, cy + dy, half * 2, 1);
  }
}

function blitSprite(spr, x, y, face, alpha = 1) {
  b.save();
  b.globalAlpha = alpha;
  b.translate(x, y);
  if (face < 0) b.scale(-1, 1);
  b.drawImage(spr.canvas, -spr.anchorX, -spr.anchorY);
  b.restore();
}

// The goal portal (replaces the chest sprite): an upright ring of swirling fire standing on the
// goal cell, hovering and bobbing like the coins, its centre filled with a swirling glow. The ring is a bright yellow-white band that cools to
// orange and red toward its edges, cut by spiral streaks that turn around it; flame wisps curl
// off the outside, embers rise, and a glow pools on the floor. Drawn per pixel so the art stays
// crisp; the win cell is still the single goal cell. Visual only: no rng, no game state.
const FIRE_COLS = ['#6e1409', '#b82d14', '#ff5a1c', '#ff8d1c', '#ffbb2e', '#ffe46a', '#fffbe0'];
const FLAME_COLS = ['#ffe46a', '#ffbb2e', '#ff8d1c', '#d9401a'];
const fireHash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
function drawPortal(px, py, now, alpha) {
  // Hovers like the coins: floats up and down a few px, the floor glow shrinking as it rises.
  const wave = Math.sin(now / 520), lift = Math.round(4 + 3 * wave);
  const rx = 17, ry = 21, cy = py - ry - lift + 2, t = now / 380;   // ring centre sits above the cell
  // Floor glow under the ring.
  b.save();
  b.globalCompositeOperation = 'lighter';
  b.fillStyle = '#ff7a2a';
  for (const [k, a] of [[1.7, .05], [1.35, .08], [1, .1]]) {
    b.globalAlpha = alpha * a * (.85 + .15 * Math.sin(now / 210)) * (1 - .12 * wave);
    pixelEllipse(px, py, Math.round(rx * k * (1 - .08 * wave)), Math.round(5 * k * (1 - .08 * wave)));
  }
  b.restore();
  // Ring body: bright band at r ~ .68, spiral streaks modulate its heat, a dark hole inside.
  for (let dy = -ry; dy < ry; dy++) {
    const v = (dy + .5) / (ry + .5);
    for (let dx = -rx; dx < rx; dx++) {
      const u = (dx + .5) / (rx + .5), r = Math.hypot(u, v);
      if (r > 1) continue;
      const ang = Math.atan2(v, u);
      const s = Math.sin(5 * ang + r * 8 - t * 1.6) * .5 + Math.sin(9 * ang - r * 12 + t * 2) * .3 +
        Math.sin(3 * ang + r * 4 - t) * .2;                       // -1..1, spirals with the spin
      const d = (r - .66) / (.22 + .05 * s), band = Math.exp(-d * d);
      const x = px + dx, y = cy + dy;
      if (r < .62 && band < .35) {                              // centre: filled with a swirling red-orange glow
        const sw = Math.sin(3 * ang - r * 9 + t * 2.2);
        const i = Math.max(0, Math.min(4, Math.floor(1.2 + (r / .62) * 1.5 + sw * .9 + s * .4)));
        b.globalAlpha = alpha;
        b.fillStyle = FIRE_COLS[i];
        b.fillRect(x, y, 1, 1);
        continue;
      }
      const heat = band * (.8 + .3 * s);
      if (heat < .1) continue;
      if (heat < .35 && fireHash(dx * 31 + dy * 17) > heat * 3) continue;   // ragged edge
      b.globalAlpha = alpha;
      b.fillStyle = FIRE_COLS[Math.max(0, Math.min(FIRE_COLS.length - 1, Math.floor(heat * 6.99)))];
      b.fillRect(x, y, 1, 1);
    }
  }
  // Wisps: tongues curl off the outer edge against the spin, flickering, yellow -> red.
  const TONGUES = 26;
  for (let k = 0; k < TONGUES; k++) {
    const ang = (k / TONGUES) * Math.PI * 2 + t * .5 + fireHash(k) * .3;
    const flick = .5 + .5 * Math.sin(now / 150 + k * 2.3 + fireHash(k) * 6);
    const len = 4 + Math.round(flick * 8 + fireHash(k + 40) * 6);
    for (let j = 0; j < len; j++) {
      const f = j / len, a = ang - f * .7;
      const x = Math.round(Math.cos(a) * (rx * .92 + j)), y = Math.round(Math.sin(a) * (ry * .92 + j * ry / rx));
      b.fillStyle = FLAME_COLS[Math.min(FLAME_COLS.length - 1, Math.floor(f * FLAME_COLS.length))];
      b.globalAlpha = alpha * (1 - f * .5);
      b.fillRect(px + x, cy + y, f < .5 ? 2 : 1, f < .5 ? 2 : 1);
    }
  }
  // Embers: leave the ring and drift upward, bright at birth, cooling as they fade.
  for (let k = 0; k < 24; k++) {
    const life = (now / 1100 + fireHash(k + 7)) % 1;
    const ang = fireHash(k) * Math.PI * 2;
    const x = Math.round(Math.cos(ang) * rx * (.85 + life * .35) + Math.sin(now / 300 + k) * 2);
    const y = Math.round(Math.sin(ang) * ry * .9 - life * 12);
    b.globalAlpha = alpha * (1 - life * life);
    b.fillStyle = life < .3 ? '#fffbe0' : life < .6 ? '#ffe46a' : '#ff8d1c';
    b.fillRect(px + x, cy + y, 1, 1);
  }
  b.globalAlpha = 1;
}

// A short golden glow around the knight when a coin is picked up: rings that swell and fade,
// plus four sparkles drifting up. Visual only.
function drawCoinGlow(px, py, now) {
  const t = (now - coinGlowAt) / COIN_GLOW_MS;
  if (t < 0 || t >= 1) return;
  const fade = 1 - t;
  b.save();
  b.globalCompositeOperation = 'lighter';
  b.fillStyle = '#ffc633';
  for (const [k, a] of [[1, .12], [.7, .16], [.4, .22]]) {
    b.globalAlpha = a * fade;
    pixelEllipse(px, py - 10, Math.round((8 + 14 * t) * k), Math.round((10 + 12 * t) * k));
  }
  b.globalAlpha = .9 * fade;
  b.fillStyle = '#fff1a8';
  for (let i = 0; i < 4; i++) {
    const a = i * 1.6 + 5 * t;
    b.fillRect(Math.round(px + Math.cos(a) * (6 + 10 * t)), Math.round(py - 10 - 8 * t + Math.sin(a) * 6), 1, 1);
  }
  b.restore();
}

function draw(now) {
  b.fillStyle = PALETTE.void;
  b.fillRect(0, 0, buf.width, buf.height);
  heads.clear();
  if (game) drawScene(now);
  drawBubbles(now);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buf, 0, 0, buf.width * S, buf.height * S);
  if (game) drawMinimap();
}

function drawScene(now) {
  const reveal = revealOn();
  const cx = Math.round(cam.x), cy = Math.round(cam.y);
  const { width: MW, height: MH, tiles, light } = game;
  const v = viewBounds(cx, cy);
  const known = (x, y) => light[y][x] > 0;
  const isWall = (x, y) => tiles[y][x] === '#' && !isSolidProp(x, y); // solid props are floor to the renderer
  // Whether a wall block is drawn at (x, y): used to skip hidden side faces. An unknown
  // cell in front never hides a face, so no layout leaks through.
  const wallShown = (x, y) => x >= 0 && y >= 0 && x < MW && y < MH && isWall(x, y) && (reveal || known(x, y));

  // Pass A: everything flat (floors, fog glow, trail).
  for (let d = v.dMin; d <= v.dMax; d++) {
    const [e0, e1] = eRange(v, d, -FOG_PAD, MW + FOG_PAD, MH + FOG_PAD);
    for (let e = e0; e <= e1; e += 2) {
      const x = (d + e) >> 1, y = (d - e) >> 1;
      const sx = e * HW - HW - cx, sy = d * HH - cy;
      const inMap = x >= 0 && y >= 0 && x < MW && y < MH;
      if (inMap && known(x, y)) {
        if (isWall(x, y)) continue;
        const s = shown[y][x];
        const tile = floors[bandOf(s)][Math.floor(hash(x, y) * FLOOR_VARIANTS)];
        if (s < .2) {
          b.globalAlpha = s / .2;
          b.drawImage(tile, sx, sy);
          b.globalAlpha = 1;
        } else {
          b.drawImage(tile, sx, sy);
        }
        continue;
      }
      const fd = fog[(y + FOG_PAD) * fogW + x + FOG_PAD];
      if (fd <= FOG_BANDS) b.drawImage(fogTiles[fd - 1], sx, sy);
      if (inMap && reveal && !isWall(x, y)) {
        b.globalAlpha = REVEAL_ALPHA;
        b.drawImage(floors[0][Math.floor(hash(x, y) * FLOOR_VARIANTS)], sx, sy);
        b.globalAlpha = 1;
      }
    }
  }
  drawTrail(cx, cy);
  drawLandmarks(cx, cy, known);
  drawStrikes(cx, cy, now, known, reveal);

  // Entities, sorted by depth (x+y of the cell; the larger one while moving).
  const ents = [];
  const [tx, ty] = game.treasure ?? [-1, -1]; // testbed arenas may have no chest
  const chestLit = !!game.treasure && known(tx, ty);
  if (game.treasure && (chestLit || reveal)) {
    ents.push({ depth: tx + ty, order: 0, gx: tx, gy: ty, kind: 'chest', face: 1,
      alpha: chestLit ? Math.min(1, Math.max(.15, shown[ty][tx] / .4)) : REVEAL_ALPHA });
  }
  // Coin piles: one entry per coin, so a cell listed twice is a pile of two. Fog rule: lit cells only (or Reveal).
  for (const [cx2, cy2, n] of coinCells()) {
    const lit = known(cx2, cy2);
    if (!(lit || reveal)) continue;
    ents.push({ depth: cx2 + cy2, order: -.5, gx: cx2, gy: cy2, kind: 'coin', n, face: 1,
      alpha: lit ? Math.min(1, Math.max(.15, shown[cy2][cx2] / .4)) : REVEAL_ALPHA });
  }
  if (propArt) {
    for (const p of floorProps) {
      if (p.w) { pushForge(ents, p, known, shown, reveal); continue; }
      const art = propArt.floor[p.kind];
      const lit = known(p.x, p.y);
      if (!art || !(lit || reveal)) continue;
      const px = isoX(p.x + .5, p.y + .5) - cx, py = isoY(p.x + .5, p.y + .5) - cy;
      if (px < -40 || py < -10 || px > buf.width + 40 || py > buf.height + 70) continue;
      const s = lit ? shown[p.y][p.x] : 0;
      ents.push({ depth: p.depth, order: -1, kind: 'prop', prop: p.kind, gx: p.x, gy: p.y, art: art[bandOf(s)], face: p.flip ? -1 : 1,
        phase: p.phase, alpha: lit ? Math.min(1, s / .2) : REVEAL_ALPHA });
    }
  }
  for (const ad of drawnAdversaries()) {
    const a = actors.get(ad.id);
    if (!a) continue;
    const [gx, gy] = actorPos(a, now);
    ents.push({ depth: Math.max(a.from[0] + a.from[1], a.to[0] + a.to[1]), order: 1, gx, gy, kind: 'ghost', face: a.face,
      id: ad.id, alpha: ad.visible ? 1 : REVEAL_ALPHA, chase: ad.mode === 'chase', brain: !!ad.brain?.on,
      maxHp: (ad.visible || reveal) && ad.max_hp > 0 ? Math.min(8, ad.max_hp) : 0, hp: Number(ad.hp) || 0, phase: hash(ad.id.length, ad.id.charCodeAt(ad.id.length - 1)) });
  }
  const me = actors.get('@');
  const [mx, my] = actorPos(me, now);
  ents.push({ depth: Math.max(me.from[0] + me.from[1], me.to[0] + me.to[1]), order: 2, gx: mx, gy: my, kind: 'knight', id: '@', face: me.face, alpha: 1 });
  ents.sort((p, q) => p.depth - q.depth || p.order - q.order);

  const glows = [];
  frameGlows = glows;

  // Pass B: wall blocks per diagonal, then the entities standing on that diagonal.
  let ei = 0;
  while (ei < ents.length && ents[ei].depth < v.dMin) drawEntity(ents[ei++], now, cx, cy);
  for (let d = v.dMin; d <= v.dMax; d++) {
    const [e0, e1] = eRange(v, d, 0, MW, MH);
    for (let e = e0; e <= e1; e += 2) {
      const x = (d + e) >> 1, y = (d - e) >> 1;
      if (!isWall(x, y)) continue;
      const isKnown = known(x, y);
      if (!isKnown && !reveal) continue;
      // A face is drawn unless a shown wall in front is at least as tall (it would cover it).
      const nb = blocksAt(x, y), hL = wallShown(x, y + 1) ? blocksAt(x, y + 1) : 0, hR = wallShown(x + 1, y) ? blocksAt(x + 1, y) : 0;
      const mask = (hL >= nb ? 0 : 1) | (hR >= nb ? 0 : 2);
      const s = isKnown ? shown[y][x] : 0;
      const tile = walls[bandOf(s)][hash(x, y, 3) < .5 ? 0 : 1][nb - 1][mask];
      const alpha = isKnown ? Math.min(1, s / .2) : REVEAL_ALPHA;
      if (alpha < 1) b.globalAlpha = alpha;
      const ox = e * HW - HW - cx, oy0 = d * HH - WALL_H - cy; // oy0: top of a one-block wall
      b.drawImage(tile, ox, oy0 - (nb - 1) * WALL_H);
      // Decor sits on the lowest block of its face that is not hidden by a wall in front.
      if (propArt && decorAt.size) drawDecor(decorAt.get(y * MW + x), mask, bandOf(s), ox, oy0, alpha, now, glows, nb, hL, hR);
      b.globalAlpha = 1;
    }
    while (ei < ents.length && ents[ei].depth <= d) drawEntity(ents[ei++], now, cx, cy);
  }
  while (ei < ents.length) drawEntity(ents[ei++], now, cx, cy);
  drawStrikes(cx, cy, now, known, reveal, 'edge');
  drawGlows(glows, now);
}

// Wall decor, right after its wall block (same band and alpha). Only faces that are drawn
// (mask bit set) get their decor. Items with a glow are queued for drawGlows.
function drawDecor(list, mask, band, ox, oy0, alpha, now, glows, nb, hL, hR) {
  if (!list) return;
  for (const d of list) {
    if (!(mask & (d.face === 'L' ? 1 : 2))) continue;
    const art = propArt.wall[d.kind]?.[d.face]?.[band], meta = propArt.meta[d.kind];
    if (!art) continue;
    const hn = d.face === 'L' ? hL : hR, oy = oy0 - hn * WALL_H;
    // Big decor: 1 or 2 blocks tall (d.blocks), clamped to the visible part of its wall (nb - hn).
    const tall = d.blocks > 1 && nb - hn >= 2 && propArt.wallTall[d.kind]?.[d.face]?.[band];
    const a = tall || art, m = tall ? propArt.metaTall[d.kind] : meta;
    b.drawImage(frameOf(a, now / (m.frameMs / ANIM_MS), d.phase * 4).canvas, ox, tall ? oy - WALL_H : oy);
    if (m.glow) glows.push({ d, meta: m, ox, oy, alpha, pool: hn === 0 });
  }
}

// Warm flickering light of torches, fires and gates: a few additive pixel-ellipse rings at the
// glow point on the wall face and a flat pool on the floor in front. Purely visual: it never
// feeds game.light or fog, and only decor that was drawn (known cell or Reveal map) queues one.
function drawGlows(glows, now) {
  if (!glows.length) return;
  b.save();
  b.globalCompositeOperation = 'lighter';
  for (const item of glows) {
    if (item.floor) { // floor prop: rings around the glow point, plus a flat pool at its base
      const { d, g, x, y, alpha } = item, ph = d.phase * 6.283, r = g.radius ?? 8;
      const flick = .8 + .12 * Math.sin(now / 110 + ph) + .08 * Math.sin(now / 47 + ph * 3);
      b.fillStyle = parseGlow(g.color);
      for (const [k, a] of [[1, .05], [.72, .07], [.46, .1]]) {
        b.globalAlpha = alpha * a * flick;
        pixelEllipse(Math.round(x), Math.round(y), Math.round(r * k), Math.round(r * k * .85));
      }
      continue;
    }
    const { d, meta, ox, oy, alpha, pool } = item;
    const g = meta.glow, ph = d.phase * 6.283;
    const flick = .8 + .12 * Math.sin(now / 110 + ph) + .08 * Math.sin(now / 47 + ph * 3);
    const col = parseGlow(g.color);
    const px = 1 + Math.round(g.x), fx = d.face === 'L' ? px : TW - 1 - px;
    const gx = Math.round(ox + fx), gy = Math.round(oy + bottomRow(px) + WALL_H - (meta.h - 1 - g.y));
    const r = g.radius ?? 8;
    b.fillStyle = col;
    for (const [k, a] of [[1, .05], [.72, .07], [.46, .1]]) {
      b.globalAlpha = alpha * a * flick;
      pixelEllipse(gx, gy, Math.round(r * k), Math.round(r * k * .85));
    }
    // Pool on the floor tile in front of the face (L: x, y+1; R: x+1, y); none when a lower wall is in front.
    if (!pool) continue;
    const fcx = ox + HW + (d.face === 'L' ? -HW : HW) * .8, fcy = oy + WALL_H + HH + HH * .8;
    for (const [k, a] of [[1, .05], [.62, .07]]) {
      b.globalAlpha = alpha * a * flick;
      pixelEllipse(Math.round(fcx), Math.round(fcy), Math.round(r * 1.1 * k), Math.round(r * .55 * k));
    }
  }
  b.restore();
}
const glowCache = new Map();
function parseGlow(c) {
  if (!glowCache.has(c)) glowCache.set(c, /^#[0-9a-f]{6}$/i.test(c) ? c : GLOW_COLOR);
  return glowCache.get(c);
}

// Trail: warm dotted path through visited cells (dot on each cell, half-dot between).
// Landmarks: a tiny diamond on the floor of each remembered cell. Only known cells are drawn.
function drawLandmarks(cx, cy, known) {
  const list = validLandmarks();
  if (!list.length) return;
  const W = buf.width, H = buf.height;
  for (const l of list) {
    const [x, y] = l.cell;
    if (x < 0 || y < 0 || x >= game.width || y >= game.height || !known(x, y)) continue;
    const px = Math.round((x - y) * HW - cx), py = Math.round((x + y) * HH + HH - cy);
    if (px < -4 || py < -4 || px > W + 4 || py > H + 4) continue;
    b.fillStyle = 'rgba(4, 5, 13, .7)';
    b.fillRect(px - 2, py - 1, 5, 3);
    b.fillRect(px - 1, py - 2, 3, 5);
    b.fillStyle = landmarkKind(l.kind).colour;
    b.globalAlpha = .9;
    b.fillRect(px - 1, py - 1, 3, 1);
    b.fillRect(px - 1, py + 1, 3, 1);
    b.fillRect(px, py - 1, 1, 3);
    b.globalAlpha = 1;
  }
}

// Strike overlays: per struck cell, a solid iso diamond in the flats pass (above floor, below
// entities) plus a bright outline after the entities, so a knight or ghost standing on the cell
// cannot hide it. Held at full strength for STRIKE_HOLD of STRIKE_MS, then fades. A cell is drawn
// only if it is known (lit), unless Reveal map is on, so a strike never leaks the map.
// Blocked strikes flash steel blue instead of red. The few cells are drawn per frame.
const diamondCache = new Map();
// edge: only the diamond's rim (a pixel inside whose 4-neighbour is outside), 1 art px thick.
function diamondTile(color, edge = false) {
  const key = color + (edge ? '/edge' : '');
  let c = diamondCache.get(key);
  if (!c) {
    c = makeCanvas(TW, TH);
    const g = c.getContext('2d');
    g.fillStyle = color;
    const rim = (px, py) => !inDiamond(px - 1, py) || !inDiamond(px + 1, py) || !inDiamond(px, py - 1) || !inDiamond(px, py + 1);
    for (let py = 0; py < TH; py++) for (let px = 0; px < TW; px++) if (inDiamond(px, py) && (!edge || rim(px, py))) g.fillRect(px, py, 1, 1);
    diamondCache.set(key, c);
  }
  return c;
}
// Sword slash (every attack): a pixel crescent that sweeps around the attacker through the struck cells,
// drawn per pixel in a handful of frames (no rotation, so the art stays crisp). Shape: the arc's width swells
// from a thin tail to a fat head that leads the sweep (the smear frames of a sword swing), the rim is dark
// blue, the core white. Aimed from the attacker's cell (strike.from) through the centroid of its cells;
// cells outside the light are skipped unless Reveal is on, like the diamonds.
const SLASH_FRAMES = 6;
function drawSlash(st, t, cx, cy, known, reveal) {
  if (!Array.isArray(st.cells) || !st.cells.length) return;
  const cells = st.cells.filter((c) => Array.isArray(c) && Number.isInteger(c[0]) && Number.isInteger(c[1]) && (reveal || known(c[0], c[1])));
  if (!cells.length) return; // fog: a strike nobody can see draws no slash
  const mx = cells.reduce((s, c) => s + c[0], 0) / cells.length, my = cells.reduce((s, c) => s + c[1], 0) / cells.length;
  const from = Array.isArray(st.from) ? st.from : [mx, my];
  const scr = (x, y) => [(x - y) * HW - cx, (x + y) * HH + HH - cy]; // cell centre, as the trail
  let [ox, oy] = scr(from[0], from[1]);
  const [tx, ty] = scr(mx, my);
  let dx = tx - ox, dy = ty - oy;
  if (Math.hypot(dx, dy) < 2) { dx = FACE_X[game.facing] ?? 1; dy = 0; } // no aim known: slash across the cell
  drawCrescent(ox, oy, dx, dy, t, {
    frames: SLASH_FRAMES, sweep: 2.3, reach: Math.min(26, Math.max(13, Math.hypot(dx, dy) * 1.25)),
    wTail: 1.5, wHead: 6, bow: 1.5, pal: SLASH_COLORS[st.by === 'explorer' ? 'sword' : 'claw'], alpha: st.result === 'miss' ? .6 : 1,
  });
}

// The crescent both swings share (the sword slash and the shield's parry), swept around (ox, oy) toward (dx, dy):
// `frames` discrete frames, `sweep` radians when finished, arc radius `reach`, half-width swelling from `wTail` at
// the tail to about wTail + wHead at the head, the head bowed `bow` px further out; 4 tones of `pal`, rim to core.
function drawCrescent(ox, oy, dx, dy, t, { frames, sweep, reach, wTail, wHead, bow, pal, alpha }) {
  const aim = Math.atan2(dy, dx);
  const flip = dx >= 0 ? 1 : -1; // the swing is mirrored for a cut toward the left of the screen
  const frame = Math.min(frames - 1, Math.floor(t * frames));
  const p = (frame + 1) / frames;                          // how far the head has swept
  const tail = Math.max(0, p * 1.35 - 1) * sweep;          // the tail catches up late: the crescent thins out
  const head = p * sweep;
  const fade = frame >= frames - 2 ? .55 : 1;
  const lead = flip > 0 ? aim - sweep / 2 : aim + sweep / 2; // where the sweep starts
  b.globalAlpha = alpha * fade;
  const R = Math.ceil(reach + wHead);
  for (let y = -R; y <= R; y++) {
    for (let x = -R; x <= R; x++) {
      const r = Math.hypot(x, y);
      let ang = Math.atan2(y, x) - lead;
      ang = Math.atan2(Math.sin(ang), Math.cos(ang)) * flip; // signed angle along the sweep, 0 at its start
      if (ang < tail || ang > head) continue;
      const u = (ang - tail) / Math.max(.001, head - tail);    // 0 at the tail, 1 at the head
      const w = (wTail + wHead * Math.sin(Math.min(1, u * .9 + .1) * Math.PI * .5) * (1 - .35 * (1 - u) * (1 - u))); // half-width
      const off = r - reach + (u - .5) * bow;                 // the arc bows: the head sits a touch further out
      if (Math.abs(off) > w) continue;
      const f = 1 - Math.abs(off) / w;                        // 0 at the rim, 1 on the centre line
      const tone = f > .72 && u > .25 ? 3 : f > .45 ? 2 : f > .2 ? 1 : 0;
      b.fillStyle = pal[tone];
      b.fillRect(Math.round(ox + x), Math.round(oy + y), 1, 1);
    }
  }
  b.globalAlpha = 1;
}

// Parry (a claw met the shield): the sword's crescent, smaller and in the coin-gold ramp (the shield's face),
// swept from the raised shield toward the attacker: the shield knocks the claw aside. Same frame count and
// thin-tail / fat-head shape as the slash at about half its size (radius 11, head about 4.5 px half-width).
// Skipped when the attacker's cell is outside the light unless Reveal is on, like the slash.
const PARRY_FRAMES = 6;
function drawParry(from, t, cx, cy, known, reveal) {
  if (!Number.isInteger(from[0]) || !Number.isInteger(from[1]) || !(reveal || known(from[0], from[1]))) return;
  const scr = (x, y) => [(x - y) * HW - cx, (x + y) * HH + HH - cy];
  const [kx, ky] = scr(game.pos[0], game.pos[1]);
  const [ax, ay] = scr(from[0], from[1]);
  let dx = ax - kx, dy = ay - ky;
  if (Math.hypot(dx, dy) < 2) { dx = FACE_X[game.facing] ?? 1; dy = 0; }
  const face = actors.get('@')?.face ?? 1;
  drawCrescent(kx + face * SHIELD_HOLD_X, ky - SHIELD_TOP + SHIELD_H / 2, dx, dy, t, {
    frames: PARRY_FRAMES, sweep: 1.9, reach: 11, wTail: 1, wHead: 3.5, bow: .8, pal: SLASH_COLORS.shield, alpha: 1,
  });
}

// pass 'fill' runs in the flats pass, 'edge' after the entities; only 'edge' retires strikeFx.
function drawStrikes(cx, cy, now, known, reveal, pass = 'fill') {
  if (!strikeFx) return;
  const k = (now - strikeFx.t0) / STRIKE_MS;
  if (k >= 1) { if (pass === 'edge') strikeFx = null; return; }
  const fade = k < STRIKE_HOLD ? 1 : 1 - (k - STRIKE_HOLD) / (1 - STRIKE_HOLD);
  const flash = k < STRIKE_HOLD && Math.floor(k / STRIKE_HOLD * 4) % 2 ? .7 : 1; // two pulses while held
  for (const st of strikeFx.strikes) {
    if (!Array.isArray(st?.cells)) continue;
    const blocked = st.result === 'blocked';
    const tile = diamondTile(blocked ? BLOCK_COLOR : STRIKE_COLOR, pass === 'edge');
    b.globalAlpha = fade * flash * (st.result === 'miss' ? .5 : pass === 'edge' ? 1 : .85);
    for (const c of st.cells) {
      if (!Array.isArray(c)) continue;
      const [x, y] = c;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= game.width || y >= game.height) continue;
      if (!reveal && !known(x, y)) continue;
      const sx = (x - y) * HW - HW - cx, sy = (x + y) * HH - cy; // tile top-left, as the floors in pass A
      if (sx < -TW || sy < -TH || sx > buf.width || sy > buf.height) continue;
      b.drawImage(tile, sx, sy);
    }
  }
  b.globalAlpha = 1;
  // The slash rides on the 'edge' pass (after the entities, so nothing hides it) for its own shorter time.
  if (pass === 'edge') {
    const t = (now - strikeFx.t0) / SLASH_MS, ts = (now - strikeFx.t0) / SHIELD_SLASH_MS;
    for (const st of strikeFx.strikes) {
      const blockedClaw = st.result === 'blocked' && st.by !== 'explorer';
      if (t < 1 && !blockedClaw) drawSlash(st, t, cx, cy, known, reveal); // a blocked claw shows only the shield's spark
      // A blocked claw: the raised shield parries with a small gold crescent toward the attacker.
      if (blockedClaw && ts < 1 && Array.isArray(st.from) && Array.isArray(game.pos)) drawParry(st.from, ts, cx, cy, known, reveal);
    }
  }
}

// Shield raised while game.block is active: an 11x14 art px heater shield, hand-placed like the sprites, held out
// on the knight's facing side over the small shield in its sprite (the visor stays clear). Steel ramp rim
// (outline #172531; W lit top-left edge, M right, D shaded bottom-right; W rivets in the top corners), coin-gold
// face split down a seam (h / Y lit half, y shaded half) with a domed steel boss. Symmetric, so it is not mirrored;
// the light stays upper left. Authored at full brightness; it flashes on alternate parry frames.
const SHIELD_W = 11, SHIELD_H = 14;
const SHIELD_HOLD_X = 5, SHIELD_TOP = 13; // centre column from the knight's anchor (toward its face), top row above the feet
const SHIELD_COLORS = { o: '#172531', D: '#3f5b6f', M: '#6f8fa5', L: '#abbfce', W: '#edf3f7', y: '#c98a14', Y: '#ffc633', h: '#fff0a8' };
const SHIELD_FLASH = { o: '#edf3f7', D: '#abbfce', M: '#edf3f7', L: '#ffffff', W: '#ffffff', y: '#ffc633', Y: '#fff0a8', h: '#ffffff' };
const SHIELD_ROWS = [
  '.ooooooooo.',
  'oWWLLLLLLMo',
  'oWhhhhYYyMo',
  'oLhYYYYyyMo',
  'oLhYYLYyyMo',
  'oLhYLWMyyMo',
  'oLYYMMDyyDo',
  'oLYYYDyyyDo',
  '.oLYYYyyDo.',
  '.oLYYYyyDo.',
  '..oLYYyDo..',
  '..oMYYyDo..',
  '...oMyDo...',
  '....ooo....',
];
function drawShield(x, y, now) { // x: centre column, y: top row; flashes on alternate parry frames
  const flashing = strikeFx && strikeFx.strikes.some((st) => st.result === 'blocked' && st.by !== 'explorer')
    && (now - strikeFx.t0) / SHIELD_SLASH_MS < 1 && Math.floor((now - strikeFx.t0) / SHIELD_SLASH_MS * PARRY_FRAMES) % 2 === 0;
  SHIELD_ROWS.forEach((row, ry) => [...row].forEach((ch, rx) => {
    if (ch === '.') return;
    b.fillStyle = (flashing ? SHIELD_FLASH : SHIELD_COLORS)[ch];
    b.fillRect(x - (SHIELD_W >> 1) + rx, y + ry, 1, 1);
  }));
}

function drawTrail(cx, cy) {
  const t = game.trail;
  if (!t?.length) return;
  b.fillStyle = PALETTE.trail;
  b.globalAlpha = .38;
  const W = buf.width, H = buf.height;
  for (let i = 0; i < t.length; i++) {
    const [x, y] = t[i];
    const px = (x - y) * HW - cx, py = (x + y) * HH + HH - cy;
    if (px < -HW || py < -TH || px > W + HW || py > H + TH) continue;
    b.fillRect(px - 1, py, 2, 1);
    if (i > 0) {
      const [px2, py2] = [(t[i - 1][0] - t[i - 1][1]) * HW - cx, (t[i - 1][0] + t[i - 1][1]) * HH + HH - cy];
      b.fillRect(Math.round((px + px2) / 2), Math.round((py + py2) / 2), 1, 1);
    }
  }
  b.globalAlpha = 1;
}

// The forge: one big sprite over a wx x wy block of solid cells, cut into 16 px strips along its front (the
// bottom-left face, then the bottom-right face), one strip per footprint cell on that front. Each strip is its
// own entity at its cell's depth, so the knight and the ghosts pass in front of the part of the furnace that is
// behind them and are covered by the part in front of them. flip:true draws the mirrored art (forge_<wy>x<wx>).
const FORGE_STRIP = 16;
function pushForge(ents, p, known, shown, reveal) {
  const { w: wx, h: wy } = p, flip = !!p.flip, key = flip ? `forge_${wy}x${wx}` : `forge_${wx}x${wy}`;
  const bands = propArt.floor[key];
  if (!bands) return;
  let lit = false, s = 0;
  for (let y = p.y; y < p.y + wy; y++) for (let x = p.x; x < p.x + wx; x++) if (known(x, y)) { lit = true; s = Math.max(s, shown[y][x]); }
  if (!lit && !reveal) return;
  const n = wx + wy, T = [Math.round(isoX(p.x, p.y)), Math.round(isoY(p.x, p.y))];
  for (let t = 0; t < n; t++) {
    const [gx, gy] = t < wx ? [p.x + t, p.y + wy - 1] : [p.x + wx - 1, p.y + wy - 1 - (t - wx)];
    ents.push({ depth: gx + gy, order: -1, kind: 'forge', gx, gy, key, art: bands[bandOf(s)], flip, wx, wy, t, n, T, phase: p.phase,
      alpha: lit ? Math.min(1, s / .2) : REVEAL_ALPHA });
  }
}
function drawForgeStrip(en, now, cx, cy) {
  const spr = frameOf(en.art, now, en.phase * 4), { wy, flip, t, n } = en;
  const Tx = en.T[0] - cx, Ty = en.T[1] - cy, ix = Tx - en.art.anchorX, iy = Ty - en.art.anchorY;
  if (Tx + spr.w < 0 || Tx - spr.w > buf.width || Ty + spr.h < 0 || Ty - spr.h > buf.height) return;
  const lo = t === 0 ? -1e5 : Tx - FORGE_STRIP * wy + FORGE_STRIP * t, hi = t === n - 1 ? 1e5 : lo + FORGE_STRIP;
  const c0 = Math.max(0, flip ? 2 * Tx - ix - hi + 1 : lo - ix), c1 = Math.min(spr.w, flip ? 2 * Tx - ix - lo + 1 : hi - ix);
  if (c1 > c0) {
    b.save();
    b.globalAlpha = en.alpha;
    if (flip) { b.translate(2 * Tx + 1, 0); b.scale(-1, 1); }
    b.drawImage(spr.canvas, c0, 0, c1 - c0, spr.h, ix + c0, iy, c1 - c0, spr.h);
    b.restore();
  }
  const fg = t === 0 && frameGlows && propArt?.floorMeta[en.key]?.glow;
  if (fg) { // coals at the fire mouth: same flicker as the other glowing floor props
    const dx = fg.x - en.art.anchorX;
    frameGlows.push({ floor: true, d: en, g: fg, x: Tx + (flip ? -dx : dx), y: Ty + fg.y - en.art.anchorY, alpha: en.alpha });
  }
}

let frameGlows = null; // this frame's glow queue (drawEntity pushes the glow of floor props)
function drawEntity(en, now, cx, cy) {
  if (en.kind === 'forge') { drawForgeStrip(en, now, cx, cy); return; }
  const px = Math.round(isoX(en.gx + .5, en.gy + .5)) - cx;
  const py = Math.round(isoY(en.gx + .5, en.gy + .5)) - cy;
  if (px < -40 || py < -10 || px > buf.width + 40 || py > buf.height + 60) return;
  if (en.kind === 'prop') {
    blitSprite(frameOf(en.art, now, en.phase * 4), px, py, en.face, en.alpha);
    const fg = propArt?.floorMeta[en.prop]?.glow;
    if (fg && frameGlows) { // blue flames / water, forge coals: glow on the floor prop, same flicker as torches
      const dx = fg.x - en.art.anchorX;
      frameGlows.push({ floor: true, d: en, g: fg, x: px + (en.face < 0 ? -dx : dx), y: py + fg.y - en.art.anchorY, alpha: en.alpha });
    }
    return;
  }
  if (en.kind === 'coin') {
    const bob = Math.round(Math.sin(now / 380 + en.gx * 1.7 + en.gy * 2.3));
    b.globalAlpha = en.alpha * .7;
    b.fillStyle = PALETTE.shadow;
    pixelEllipse(px, py + 1, 4, 1);
    b.globalAlpha = 1;
    if (en.n > 1) blitSprite(sprites.coin, px + 3, py + 1, 1, en.alpha); // a second coin peeks out behind
    blitSprite(sprites.coin, px - (en.n > 1 ? 1 : 0), py - 1 + bob, 1, en.alpha);
    return;
  }
  if (en.kind === 'chest') {
    drawPortal(px, py, now, en.alpha);
    return;
  }
  if (en.kind === 'knight') {
    b.fillStyle = PALETTE.shadow;
    pixelEllipse(px, py, 6, 2);
    const spr = frameOf(sprites.knight, now);
    // Hit protection (grace after a hit): the knight blinks.
    const blink = game?.invulnerable && Math.floor(now / BLINK_MS) % 2 === 1;
    blitSprite(spr, px, py, en.face, blink ? .3 : 1);
    drawCoinGlow(px, py, now);
    if (game?.block) drawShield(px + en.face * SHIELD_HOLD_X, py - SHIELD_TOP, now); // raised on the facing side, below the visor
    heads.set(en.id, { x: px, y: py - spr.anchorY, alpha: 1 });
    return;
  }
  // Ghost: hovering bob with a floor shadow that shrinks as it rises; red glow when chasing.
  const wave = Math.sin(((now / BOB_MS) + en.phase) * Math.PI * 2);
  const bob = Math.round(wave * BOB_PX);
  b.globalAlpha = en.alpha;
  b.fillStyle = PALETTE.shadow;
  pixelEllipse(px, py, 6 - (bob < 0 ? 1 : 0), 2);
  if (en.chase) {
    const pulse = .75 + .25 * Math.sin(now / 180);
    b.fillStyle = PALETTE.enemy;
    for (const [rx, ry, a] of [[15, 12, .16], [12, 9, .2], [9, 7, .28]]) {
      b.globalAlpha = en.alpha * a * pulse;
      pixelEllipse(px, py - 10 + bob, rx, ry);
    }
  }
  b.globalAlpha = 1;
  const spr = frameOf(sprites.ghost, now, en.phase * 4);
  blitSprite(spr, px, py - 2 + bob, en.face, en.alpha);
  const pipY = py - 2 + bob - spr.anchorY - (en.brain ? 9 : 2) - 3;
  heads.set(en.id, { x: px, y: py - 2 + bob - spr.anchorY - (en.brain ? 8 : 0) - (en.maxHp ? 5 : 0), alpha: en.alpha });
  // Health bar: one pip per hit point, over every ghost in sight (the explorer sees it too: threats.visible hp);
  // an unseen ghost's shows only with Reveal on.
  if (en.maxHp) {
    const x0 = px - Math.floor((en.maxHp * 4 - 1) / 2);
    b.globalAlpha = en.alpha;
    for (let i = 0; i < en.maxHp; i++) {
      b.fillStyle = PALETTE.brainEdge;
      b.fillRect(x0 + i * 4 - 1, pipY - 1, 4, 4);
      b.fillStyle = i < en.hp ? PALETTE.enemy : '#2c3d72';
      b.fillRect(x0 + i * 4, pipY, 2, 2);
    }
    b.globalAlpha = 1;
  }
  // Brain on: a small cyan pixel diamond floating above the head (distinct from the red chase glow).
  if (en.brain) {
    const top = py - 2 + bob - spr.anchorY - 5;
    b.globalAlpha = en.alpha;
    b.fillStyle = PALETTE.brainEdge;
    b.fillRect(px - 1, top - 2, 3, 5);
    b.fillRect(px - 2, top - 1, 5, 3);
    b.fillStyle = PALETTE.brain;
    b.fillRect(px, top - 1, 1, 3);
    b.fillRect(px - 1, top, 3, 1);
    b.globalAlpha = 1;
  }
}

// ---------- thought bubbles ----------
// When a character settles on a new approach in its memory, its text floats over the
// character's head for a few readable seconds, then fades. One bubble per character: a new
// approach replaces the text and restarts the timer. Keyed on id@since_step, so resuming a
// parked approach counts as a new thought. A bubble shows only while its character is drawn
// (fog), dimmed like the character under Reveal map; its timer runs on regardless.

const BUBBLE_IN = 200, BUBBLE_OUT = 400;
const bubbleLayer = $('bubbles');
const heads = new Map();   // id -> { x, y, alpha } in buf px, refreshed every frame by drawEntity
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

// Short first-person lines per approach id (explorer and ghosts). One is picked at random each time a
// bubble shows, never the one the same character showed last. Visual only: no server state, no rng().
const THOUGHTS = {
  nearest_frontier: ["Let's check the closest dark edge.", 'Something lurks in that dark corner.', 'What is just past the light?', 'Closest shadow first.'],
  largest_unexplored: ['That big dark patch looks promising.', 'So much unexplored dark over there!', 'Adventure lies in that gloom.', 'The biggest mystery is that way.'],
  far_side: ["Let's try the far side of this place.", 'Somewhere far from here, then.', 'I have not been over there yet.', 'Time for fresh ground.'],
  collect_coins: ["Coins! That's worth a detour!", 'Shiny! Mine!', 'I can hear the coins calling.', 'Gold, gold, gold!'],
  go_to_exit: ['The portal! Time to leave.', 'Home stretch. To the portal!', 'Loot secured. Out we go.', 'Out of this place at last.'],
  slip_past: ['I can slip past!', 'Quiet feet, quiet feet...', 'Tiptoe around it.', 'Sneaking by, nothing to see.'],
  run_away: ['Run away!', 'Nope nope nope!', 'Time to go. Now!', 'Too many claws, bye!'],
  engage: ['Have at you!', 'Charge!!', 'Take this!!', 'Taste my sword!!'],
  hide: ['Duck out of sight.', 'Hush, hide, wait...', 'Into the shadows!', 'Nobody here but me.'],
  race_to_exit: ['Go for the portal!', 'Race you to the exit!', 'Faster, faster, portal!', 'Catch me if you can!'],
  carry_on: ["It hasn't seen me, keep going.", 'Still unseen. Good.', 'Eyes elsewhere, ghost...', 'Stay calm, carry on.'],
  direct_pursuit: ['I see you!', 'Get back here!', 'You cannot hide!', 'Got you in my sights!'],
  cut_off: ['You will come this way.', 'I will block your path!', 'Cutting you off!', 'Wait for it...'],
  sweep_last_seen: ['Where did you go?', 'It was right here...', 'Come out, come out!', 'Just checking the corners.'],
};
// Mood lines for the explorer (PLAN-moods): shown when the approach changes, picked at random like THOUGHTS.
const MOOD_THOUGHTS = {
  panic: ['Out! Out! Out!', 'Just get away from here!', 'Nothing matters but the way out!'],
  wary: ["Something's wrong. Keep my distance.", "I don't like this. Back off.", 'Find cover first, think later.'],
  guarded: ['Stay sharp, keep moving.', 'Eyes open, away from trouble.', 'No detours. Careful progress.'],
  cautious: ['Slow down, check the corners.', 'Stay clear and slip past.', "Fight only if I'm cornered."],
  steady: ['Stick to the plan.', 'One room at a time.', 'If one shows up, I can handle it.'],
  greedy: ['I smell coins nearby.', 'Worth a detour.', "Let's see what else is in here."],
  bold: ['Come at me.', 'I can take this one.', 'Press on, no backing down.'],
  fearless: ['Bring them all.', "I'm cutting through.", 'Nothing here stops me.'],
};
const lastPick = new Map(); // character id -> last line shown
function thoughtFor(charId, approachId, fallback, moodId = null) {
  const pool = (moodId && MOOD_THOUGHTS[moodId]) || THOUGHTS[approachId];
  if (!pool) return fallback;
  const prev = lastPick.get(charId);
  const options = pool.filter((t) => t !== prev);
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
    out.push({ id: ad.id, key: `${br?.approach}@${br?.approach_since}`, text: br?.approach ? () => thoughtFor(ad.id, br.approach, br.approach_text) : null, kind: 'adversary' });
  }
  return out;
}

// After every new view. prime: note the current approaches without showing them.
function updateThoughts(prime = false) {
  for (const c of currentApproaches()) think(c.id, c.key, prime ? null : c.text, c.kind, c.tag);
}

function clearThoughts() {
  thoughts.clear();
  bubbleLayer.replaceChildren();
}

function drawBubbles(now) {
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

// ---------- minimap ----------
// Top-down. Known cells are painted once per change into a W x H offscreen image (1 px
// per cell) on the same warm-to-navy ramp, then scaled up. Markers and the (rotated)
// viewport outline are drawn on top each frame.

const mini = $('minimap');
const mctx = mini.getContext('2d');
const tilesImg = document.createElement('canvas');
let miniDirty = true;
let miniScale = 1;
const MINI_FLOOR = Array.from({ length: BANDS }, (_, i) => mix(ramp('floorHi', i), ramp('wallTopHi', i), .5));
const MINI_WALL = Array.from({ length: BANDS }, (_, i) => ramp('wallR', i));

function rebuildMinimapTiles() {
  const { width: w, height: h } = game;
  tilesImg.width = w;
  tilesImg.height = h;
  const tctx = tilesImg.getContext('2d');
  const img = tctx.createImageData(w, h);
  const reveal = revealOn();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = game.light[y][x];
      if (l <= 0 && !reveal) continue;
      const wall = game.tiles[y][x] === '#' && !isSolidProp(x, y);
      const col = (wall ? MINI_WALL : MINI_FLOOR)[l > 0 ? bandOf(l) : 0];
      img.data.set([col[0], col[1], col[2], l > 0 ? 255 : 110], (y * w + x) * 4);
    }
  }
  tctx.putImageData(img, 0, 0);

  // Minimap size in CSS px: longest side ~ MINI_MAX, capped to a share of the board.
  const maxSide = Math.max(60, Math.min(MINI_MAX, viewW * .3, viewH * .4));
  miniScale = maxSide / Math.max(w, h);
  const cssW = Math.round(w * miniScale), cssH = Math.round(h * miniScale);
  mini.style.width = `${cssW}px`;
  mini.style.height = `${cssH}px`;
  mini.width = Math.round(cssW * dpr);
  mini.height = Math.round(cssH * dpr);
  miniDirty = false;
}

function drawMinimap() {
  if (miniDirty) rebuildMinimapTiles();
  const s = miniScale;
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, mini.width, mini.height);
  mctx.imageSmoothingEnabled = false;
  mctx.drawImage(tilesImg, 0, 0, game.width * s, game.height * s);

  const dot = ([x, y], colour, r) => {
    mctx.fillStyle = colour;
    mctx.fillRect((x + .5) * s - r, (y + .5) * s - r, r * 2, r * 2);
  };
  if (game.treasure && (game.light[game.treasure[1]][game.treasure[0]] > 0 || revealOn())) dot(game.treasure, PALETTE.chest, Math.max(2, s));
  for (const [x, y] of coinCells()) if (game.light[y][x] > 0 || revealOn()) dot([x, y], '#ffd95a', Math.max(1.5, s * .6));
  for (const a of drawnAdversaries()) {
    mctx.globalAlpha = a.visible ? 1 : .5;
    dot(a.pos, PALETTE.enemy, Math.max(1.5, s * .8));
  }
  mctx.globalAlpha = 1;
  for (const l of validLandmarks()) {
    const [x, y] = l.cell;
    if (x < 0 || y < 0 || x >= game.width || y >= game.height || !(game.light[y][x] > 0)) continue;
    mctx.strokeStyle = landmarkKind(l.kind).colour;
    mctx.lineWidth = 1;
    const r = Math.max(2, s * .9);
    mctx.strokeRect((x + .5) * s - r, (y + .5) * s - r, r * 2, r * 2);
  }
  dot(game.pos, PALETTE.explorer, Math.max(2, s));

  // Viewport outline: the buffer's corners, inverse-projected to grid space.
  const cx = Math.round(cam.x), cy = Math.round(cam.y), W = buf.width, H = buf.height;
  mctx.strokeStyle = 'rgba(255, 217, 140, .6)';
  mctx.lineWidth = 1;
  mctx.beginPath();
  [[cx, cy], [cx + W, cy], [cx + W, cy + H], [cx, cy + H]].forEach(([X, Y], i) => {
    const gx = X / TW + Y / TH, gy = Y / TH - X / TW;
    if (i) mctx.lineTo(gx * s, gy * s);
    else mctx.moveTo(gx * s, gy * s);
  });
  mctx.closePath();
  mctx.stroke();
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
      el('span', ready ? 'ready' : `cooldown ${k.cooldown_left ?? '?'}`, 'skill-state'),
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

// 8-bit hearts: one per life, filled while it lasts.
const HEART_ROWS = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
function renderHearts() {
  const max = game?.max_health ?? 0, hp = game?.health ?? 0;
  const NS = 'http://www.w3.org/2000/svg';
  const svgs = [];
  for (let i = 0; i < max; i++) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 7 6');
    svg.setAttribute('class', i < hp ? 'full' : 'empty');
    HEART_ROWS.forEach((row, y) => [...row].forEach((c, x) => {
      if (c !== 'X') return;
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', 1); r.setAttribute('height', 1);
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
  const c = lastConfidence ?? (fromMemory ? { value: fromMemory.value, band: (CONFIDENCE_BANDS.find(([lo]) => fromMemory.value >= lo) ?? [0, 'shaken'])[1], delta: 0 } : null);
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
    const li = el('li', `${e.text} `, ['caught', 'hit', 'strike', 'blocked', 'dispelled', 'struck', 'bump', 'coin', 'coin_drop'].includes(e.type) ? e.type : e.type.startsWith('brain_') || e.type === 'decision' ? e.type : '');
    li.append(el('span', `(step ${e.step})`));
    return li;
  }));
}

const BLINK_MS = 120; // knight blink half-period while hit protection lasts
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
  struck: (id, e) => `Jev struck ${id}${Number.isFinite(e.hp) ? ` (${e.hp} hp left)` : ''}`,
  bump: (id) => `${id} bumped Jev`,
  coin_drop: (id) => `${id} dropped a coin`,
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
    if (e.type === 'dispelled') actors.delete(e.id); // snap: no tween
    const text = e.type === 'strike' ? strikeText(e, turn) : (EVENT_TEXT[e.type] ?? ((id) => `${id}: ${e.type}`))(e.id, e);
    if (text == null) continue;
    eventLog.unshift({ step: turn.step ?? game.steps, text: Array.isArray(e.at) && e.type !== 'struck' ? `${text} at (${e.at.join(',')})` : text, type: e.type });
  }
  eventLog.length = Math.min(eventLog.length, LOG_MAX);
  if ((turn.events ?? []).some((e) => e.type === 'hit')) flashHit();
  if ((turn.events ?? []).some((e) => e.type === 'coin')) coinGlowAt = performance.now();
}

// Brief red flash over the board when Jev loses a life (restarts the CSS animation).
let coinGlowAt = -1e9; // when the knight last picked up a coin (drives the golden glow)
const COIN_GLOW_MS = 700;

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
  resetBoard();
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

      game = res.data.game;
      memory = res.data.memory;
      renderTurn(res.data.turn);
      renderMemory();
      renderReview();
      boardUpdate();
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

async function init() {
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
$('reveal').onchange = () => { miniDirty = true; };
$('delay').oninput = () => { $('delay-value').textContent = `${delayMs()} ms`; };

resizeBoard();

let lastFrame = performance.now();
(function frame(now) {
  if ((window.devicePixelRatio || 1) !== dpr) resizeBoard(); // e.g. moved to another monitor
  moveCamera(now - lastFrame);
  easeLight(now - lastFrame);
  lastFrame = now;
  draw(now);
  requestAnimationFrame(frame);
})(performance.now());

init().catch((err) => setStatus(`Could not reach the server: ${err.message}`, true));
