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
let elapsed = 0, resumedAt = 0;

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

async function api(method, path) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---------- look: isometric 8-bit ----------
// Everything is drawn in "art pixels" into a small offscreen buffer, which is then
// blitted to the board at an integer scale with smoothing off.

const TW = 32, TH = 16;           // tile diamond, art px
const HW = TW / 2, HH = TH / 2;
const WALL_H = 11;                // raised wall block height, art px
const BANDS = 8;                  // light bands for known cells
const FOG_BANDS = 5;              // glow bands for unknown cells (distance 1..5 to known)
const FOG_PAD = FOG_BANDS;        // the glow may spill this far past the map edge
const FLOOR_VARIANTS = 6;
const TWEEN_MS = 150;             // entity move tween
const BOB_PX = 2, BOB_MS = 1600;  // ghost hover
const ANIM_MS = 260;              // idle animation frame time
const REVEAL_ALPHA = .42;         // cells and ghosts shown only because of "Reveal map"

// Known stone ramps from cold navy (light 0.2, the edge of what Jev has seen) through
// dusky stone to warm torchlit amber (light 1.0, where Jev walked). Three stops each.
const PALETTE = {
  void: '#05060c',
  floor:      ['#1c2742', '#4b4757', '#b07a40'],
  floorHi:    ['#25345a', '#5d586a', '#d29e5c'],
  floorLo:    ['#162038', '#3c3948', '#93622f'],
  mortar:     ['#0c1224', '#24212e', '#553419'],
  wallTop:    ['#33476f', '#6d6878', '#d3a264'],
  wallTopHi:  ['#4b6395', '#8c8597', '#f2c98a'],
  wallL:      ['#1f2c4b', '#48434f', '#8d5d34'],
  wallR:      ['#141c34', '#302c39', '#5d3b20'],
  wallMortar: ['#0a0f1f', '#1b1923', '#37210f'],
  fog:        ['#121b33', '#0e1529', '#0b1020', '#080b17', '#06080f'], // distance 1..5
  trail: '#ffd98c',
  explorer: '#ffe7b0', chest: '#f2c040', enemy: '#ff4a3a', shadow: 'rgba(0,0,0,.45)',
  brain: '#7ee8ff', brainEdge: '#0b2a33',   // "Jev brain on" marker above a ghost
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

// Pre-rendered tiles: floors[band][variant], walls[band][top][mask], fogTiles[d-1].
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
  walls.push(capPatterns.map((cap, ci) => [0, 1, 2, 3].map((mask) => {
    const c = makeCanvas(TW, TH + WALL_H);
    const g = c.getContext('2d');
    for (let px = 0; px < TW; px++) {
      const left = px < HW;
      if (!(mask & (left ? 1 : 2))) continue;
      const face = faces[left ? 'L' : 'R'];
      const r0 = bottomRow(px) + 1, u = left ? px : TW - 1 - px;
      for (let k = 0; k < WALL_H; k++) {
        const course = Math.floor(k / 4);
        let col = face;
        if (k % 4 === 3 || k === WALL_H - 1 || (u + course * 3 + ci) % 6 === 0) col = mortar;
        else if (k === 0) col = mix(face, mortar, .35);                       // shade under the cap
        else if (hash(Math.floor((u + course * 3) / 6), course, ci + px * 0 + (left ? 3 : 4)) < .3) col = mix(face, mortar, .25);
        else if (left && px === HW - 1) col = mix(face, top, .3);             // front corner catches light
        g.fillStyle = css(col);
        g.fillRect(px, r0 + k, 1, 1);
      }
    }
    paint(c, cap, tc);
    return c;
  })));
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
      ['#b02828', 6, 0, 3, 3], ['#c8ccd6', 3, 3, 9, 7], ['#1a1d26', 8, 6, 4, 1],
      ['#9a2020', 2, 10, 4, 9], ['#7d8494', 4, 10, 7, 8], ['#c8a040', 9, 11, 4, 6], ['#3a3d48', 4, 18, 3, 3], ['#3a3d48', 8, 18, 3, 3],
    ]),
    ghost: spriteFrom(14, 18, 7, 17, [
      ['#c9ccd4', 3, 0, 8, 2], ['#c9ccd4', 1, 2, 12, 11], ['#9da1ac', 1, 13, 3, 3], ['#9da1ac', 5, 13, 3, 4], ['#9da1ac', 10, 13, 3, 3],
      ['#ff3030', 7, 5, 2, 2], ['#ff3030', 10, 5, 2, 2],
    ]),
    chest: spriteFrom(14, 11, 7, 9, [
      ['#6b3d1c', 1, 1, 12, 9], ['#8e5626', 1, 1, 12, 3], ['#f2c040', 1, 4, 12, 1], ['#f2c040', 6, 4, 2, 3],
    ]),
  };
}
let sprites = fallbackSprites();
import('./sprites.js')
  .then((m) => {
    const got = m.buildSprites();
    for (const k of ['knight', 'ghost', 'chest']) if (got?.[k]?.canvas) sprites[k] = got[k];
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
  floorProps = (game.props ?? []).map((p) => {
    if (p.solid) solidProp[p.y * W + p.x] = 1;
    return { ...p, depth: p.x + p.y, phase: hash(p.x, p.y, 9) };
  });
  decorAt = new Map();
  for (const d of game.decor ?? []) {
    const k = d.y * W + d.x;
    (decorAt.get(k) ?? decorAt.set(k, []).get(k)).push({ ...d, phase: hash(d.x, d.y, 5) });
  }
}
const isSolidProp = (x, y) => solidProp[y * game.width + x] === 1;

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
  for (const ad of game.adversaries ?? []) {
    const prev = actors.get(ad.id);
    const jumped = prev && Math.abs(ad.pos[0] - prev.to[0]) + Math.abs(ad.pos[1] - prev.to[1]) > 1;
    moveActor(ad.id, ad.pos, now, !prev?.drawn || jumped);
    actors.get(ad.id).drawn = ad.visible || revealOn();
  }
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
    dMax: Math.ceil((cy + buf.height) / HH) + 6,
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

function resetBoard() {
  shown = game.light.map((row) => row.map(() => 0));
  miniDirty = true;
  computeFog();
  indexProps();
  syncActors(true);
  snapCamera();
}

// A new view arrived (a step): refresh everything derived from it.
function boardUpdate() {
  miniDirty = true;
  computeFog();
  indexProps();
  syncActors(false);
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

  // Entities, sorted by depth (x+y of the cell; the larger one while moving).
  const ents = [];
  const [tx, ty] = game.treasure;
  const chestLit = known(tx, ty);
  if (chestLit || reveal) {
    ents.push({ depth: tx + ty, order: 0, gx: tx, gy: ty, kind: 'chest', face: 1,
      alpha: chestLit ? Math.min(1, Math.max(.15, shown[ty][tx] / .4)) : REVEAL_ALPHA });
  }
  if (propArt) {
    for (const p of floorProps) {
      const art = propArt.floor[p.kind];
      const lit = known(p.x, p.y);
      if (!art || !(lit || reveal)) continue;
      const px = isoX(p.x + .5, p.y + .5) - cx, py = isoY(p.x + .5, p.y + .5) - cy;
      if (px < -40 || py < -10 || px > buf.width + 40 || py > buf.height + 70) continue;
      const s = lit ? shown[p.y][p.x] : 0;
      ents.push({ depth: p.depth, order: -1, kind: 'prop', gx: p.x, gy: p.y, art: art[bandOf(s)], face: p.flip ? -1 : 1,
        phase: p.phase, alpha: lit ? Math.min(1, s / .2) : REVEAL_ALPHA });
    }
  }
  for (const ad of drawnAdversaries()) {
    const a = actors.get(ad.id);
    if (!a) continue;
    const [gx, gy] = actorPos(a, now);
    ents.push({ depth: Math.max(a.from[0] + a.from[1], a.to[0] + a.to[1]), order: 1, gx, gy, kind: 'ghost', face: a.face,
      id: ad.id, alpha: ad.visible ? 1 : REVEAL_ALPHA, chase: ad.mode === 'chase', brain: !!ad.brain?.on, phase: hash(ad.id.length, ad.id.charCodeAt(ad.id.length - 1)) });
  }
  const me = actors.get('@');
  const [mx, my] = actorPos(me, now);
  ents.push({ depth: Math.max(me.from[0] + me.from[1], me.to[0] + me.to[1]), order: 2, gx: mx, gy: my, kind: 'knight', id: '@', face: me.face, alpha: 1 });
  ents.sort((p, q) => p.depth - q.depth || p.order - q.order);

  const glows = [];

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
      const mask = (wallShown(x, y + 1) ? 0 : 1) | (wallShown(x + 1, y) ? 0 : 2);
      const s = isKnown ? shown[y][x] : 0;
      const tile = walls[bandOf(s)][hash(x, y, 3) < .5 ? 0 : 1][mask];
      const alpha = isKnown ? Math.min(1, s / .2) : REVEAL_ALPHA;
      if (alpha < 1) b.globalAlpha = alpha;
      const ox = e * HW - HW - cx, oy = d * HH - WALL_H - cy;
      b.drawImage(tile, ox, oy);
      if (propArt && decorAt.size) drawDecor(decorAt.get(y * MW + x), mask, bandOf(s), ox, oy, alpha, now, glows);
      b.globalAlpha = 1;
    }
    while (ei < ents.length && ents[ei].depth <= d) drawEntity(ents[ei++], now, cx, cy);
  }
  while (ei < ents.length) drawEntity(ents[ei++], now, cx, cy);
  drawGlows(glows, now);
}

// Wall decor, right after its wall block (same band and alpha). Only faces that are drawn
// (mask bit set) get their decor. Items with a glow are queued for drawGlows.
function drawDecor(list, mask, band, ox, oy, alpha, now, glows) {
  if (!list) return;
  for (const d of list) {
    if (!(mask & (d.face === 'L' ? 1 : 2))) continue;
    const art = propArt.wall[d.kind]?.[d.face]?.[band], meta = propArt.meta[d.kind];
    if (!art) continue;
    b.drawImage(frameOf(art, now / (meta.frameMs / ANIM_MS), d.phase * 4).canvas, ox, oy);
    if (meta.glow) glows.push({ d, meta, ox, oy, alpha });
  }
}

// Warm flickering light of torches, fires and gates: a few additive pixel-ellipse rings at the
// glow point on the wall face and a flat pool on the floor in front. Purely visual: it never
// feeds game.light or fog, and only decor that was drawn (known cell or Reveal map) queues one.
function drawGlows(glows, now) {
  if (!glows.length) return;
  b.save();
  b.globalCompositeOperation = 'lighter';
  for (const { d, meta, ox, oy, alpha } of glows) {
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
    // Pool on the floor tile in front of the face (L: x, y+1; R: x+1, y).
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

function drawEntity(en, now, cx, cy) {
  const px = Math.round(isoX(en.gx + .5, en.gy + .5)) - cx;
  const py = Math.round(isoY(en.gx + .5, en.gy + .5)) - cy;
  if (px < -40 || py < -10 || px > buf.width + 40 || py > buf.height + 60) return;
  if (en.kind === 'prop') {
    blitSprite(frameOf(en.art, now, en.phase * 4), px, py, en.face, en.alpha);
    return;
  }
  if (en.kind === 'chest') {
    b.globalAlpha = en.alpha * .8;
    b.fillStyle = PALETTE.shadow;
    pixelEllipse(px, py + 1, 7, 2);
    b.globalAlpha = 1;
    blitSprite(frameOf(sprites.chest, now), px, py, 1, en.alpha);
    return;
  }
  if (en.kind === 'knight') {
    b.fillStyle = PALETTE.shadow;
    pixelEllipse(px, py, 6, 2);
    const spr = frameOf(sprites.knight, now);
    blitSprite(spr, px, py, en.face);
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
  heads.set(en.id, { x: px, y: py - 2 + bob - spr.anchorY - (en.brain ? 8 : 0), alpha: en.alpha });
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

// tag: the explorer's sentiment id (v4). A new sentiment on the same approach re-shows the
// bubble too; both changing on one tick still shows it once.
function think(id, key, text, kind, tag = null) {
  let t = thoughts.get(id);
  if (!t) {
    const node = el('div', '', `bubble ${kind}`);
    bubbleLayer.append(node);
    t = { key: null, tag: null, el: node };
    thoughts.set(id, t);
  }
  if (t.key === key && t.tag === tag) return;
  t.key = key;
  t.tag = tag;
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

// The approach each character holds now, as { id, key, text, kind } (text null = no thought).
function currentApproaches() {
  const out = [];
  if (memory?.approach) {
    const a = memory.approach;
    // v4: the first-person thought, tagged with the sentiment; older backends only have `current`.
    out.push({ id: '@', key: `${a.id}@${a.since_step}`, text: a.thought || a.current, kind: 'explorer', tag: memory.sentiment?.id ?? null });
  }
  for (const ad of game?.adversaries ?? []) {
    const br = ad.brain;
    // Brain off is code patrol, not a formulated approach: no bubble.
    out.push({ id: ad.id, key: `${br?.approach}@${br?.approach_since}`, text: br?.approach ? br.approach_text : null, kind: 'adversary' });
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
  const [tx, ty] = game.treasure;
  if (game.light[ty][tx] > 0 || revealOn()) dot(game.treasure, PALETTE.chest, Math.max(2, s));
  for (const a of drawnAdversaries()) {
    mctx.globalAlpha = a.visible ? 1 : .5;
    dot(a.pos, PALETTE.enemy, Math.max(1.5, s * .8));
  }
  mctx.globalAlpha = 1;
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

function renderMind() {
  const s = memory?.sentiment;
  const chip = $('sentiment-chip');
  chip.textContent = s ? label(s.id) : '—';
  if (s) chip.dataset.sentiment = s.id;
  else delete chip.dataset.sentiment;
  $('sentiment-since').textContent = s?.since_step != null ? `since step ${s.since_step}` : '';
  $('profile-note').textContent = s?.profile_note ?? (s ? '' : 'No sentiment yet.');
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

function renderMemory() {
  $('steps').textContent = game ? game.steps : 0;
  $('explored').textContent = game ? `${Math.round(game.explored_pct)}%` : '0%';
  $('latency').textContent = lastLatency == null ? '—' : `${lastLatency} ms`;
  $('adv-latency').textContent = advLatency == null ? '—' : `${advLatency} ms`;
  $('mapsize').textContent = game ? `${game.width}×${game.height}` : '—';
  renderDanger();
  renderAdversaries();
  renderMind();
  if (!memory) return;

  $('objective').textContent = memory.objective;
  $('approach').textContent = memory.approach.current;
  $('approach-since').textContent = `(since step ${memory.approach.since_step})`;
  approachesUsed.add(memory.approach.id);
  $('tried').replaceChildren(...memory.approach.tried.map((t) => {
    approachesUsed.add(t.id);
    const li = el('li');
    li.append(el('s', t.approach), el('span', ` steps ${t.steps}: ${t.reason}`, 'why'));
    return li;
  }));

  const findings = memory.findings.length
    ? [...memory.findings].reverse().map((f) => {
      const li = el('li', `${f.fact} `);
      li.append(el('span', `(step ${f.step})`));
      return li;
    })
    : [el('li', 'None yet.', 'muted')];
  $('findings').replaceChildren(...findings);
}

// Safe / Chased: from memory.danger when the brain provides it, else from visible chasers.
function dangerStatus() {
  if (memory?.danger?.status) return memory.danger.status;
  return (game?.adversaries ?? []).some((a) => a.visible && a.mode === 'chase') ? 'chased' : 'safe';
}

function renderDanger() {
  const status = game?.lost ? 'caught' : dangerStatus();
  const chip = $('danger-chip');
  chip.textContent = status === 'caught' ? 'Caught' : status === 'chased' ? 'Chased' : 'Safe';
  chip.className = `chip ${status === 'safe' ? 'safe' : 'chased'}`;

  const d = memory?.danger;
  const visible = (game?.adversaries ?? []).filter((a) => a.visible).length;
  const parts = [];
  if (d) {
    parts.push(d.status === 'chased' ? `Chased since step ${d.since_step}.` : `Safe${d.since_step ? ` since step ${d.since_step}` : ''}.`);
    parts.push(`Adversaries seen: ${d.adversaries_seen ?? 0}.`);
  }
  parts.push(`In sight now: ${visible}.`);
  $('danger').textContent = parts.join(' ');
  $('danger').className = status === 'safe' ? 'muted' : '';

  $('events').replaceChildren(...eventLog.map((e) => {
    const li = el('li', `${e.text} `, e.type === 'caught' ? 'caught' : e.type.startsWith('brain_') || e.type === 'decision' ? e.type : '');
    li.append(el('span', `(step ${e.step})`));
    return li;
  }));
}

const EVENT_TEXT = {
  spotted: (id) => `${id} spotted Jev and gives chase`,
  lost_sight: (id) => `${id} lost sight of Jev and is searching`,
  gave_up: (id) => `${id} gave up the search`,
  caught: (id) => `${id} caught Jev`,
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

function logEvents(turn) {
  for (const e of turn.events ?? []) {
    const text = (EVENT_TEXT[e.type] ?? ((id) => `${id}: ${e.type}`))(e.id, e);
    eventLog.unshift({ step: turn.step ?? game.steps, text: e.at ? `${text} at (${e.at.join(',')})` : text, type: e.type });
  }
  eventLog.length = Math.min(eventLog.length, LOG_MAX);
}

// v4 reuses turn.decision for the approach decision ({ trigger, sentiment, tactic, apiMs }).
// Before v4 it was the move decision ({ choice, probabilities, confidence, options }).
// Tell them apart by `trigger`; the move decision then lives under another name, if any.
function splitDecisions(turn) {
  const d = turn.decision ?? null;
  const approach = d?.trigger ? d : null;
  const legacy = d && !d.trigger ? d : null;
  const move = turn.move_decision ?? turn.move ?? legacy ?? (turn.forced ? null : memory?.latest_action) ?? null;
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
  const probs = move?.probabilities ?? { [turn.dir]: 1 };
  $('forced').hidden = !turn.forced;
  $('probs').replaceChildren(...DIR_ORDER.flatMap((dir) => {
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
  lastReview = null;
  lastDecision = null;
  lastLatency = null;
  advTurns = new Map();
  advLatency = null;
  approachesUsed = new Set();
  eventLog = [];
  $('probs').replaceChildren();
  $('probs').removeAttribute('title');
  $('forced').hidden = true;
  $('move-note').textContent = '';
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
  setStatus(lost
    ? `Jev was caught by an adversary after ${game.steps} steps.`
    : `Jev found the treasure in ${game.steps} steps.`);
  $('over-title').textContent = lost ? 'Caught by an adversary' : 'Treasure found';
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
  if (res.ok && !res.data.game) res = await api('POST', '/api/new'); // no auto-start: page load costs no Jev calls
  if (!res.ok) return setStatus(`Server error: ${res.data.error || `HTTP ${res.status}`}`, true);
  loadGame(res.data);
  if (game.over) {
    setStatus(`This game is already ${game.won ? 'won' : 'lost'}. Press Reload for a new dungeon.`);
  } else {
    setStatus(game.steps ? 'Press Resume to keep exploring.' : 'Press Start to let Jev explore.');
  }
}

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
