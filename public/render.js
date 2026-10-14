// The isometric 8-bit renderer, extracted from app.js so several pages can draw the same look (the single-player
// page, and the multiplayer player page later). Everything draws in "art pixels" into a small offscreen buffer that is
// blitted to the board at an integer scale with smoothing off. No game logic and no network: it draws the view it is
// given (setView) and never reads a tile, a ghost or a chest the view does not carry. Fog rules from AGENTS.md hold:
// unknown cells are never drawn (unless the Reveal callback says so), a teammate on an unlit cell is only an outline.
//
// const r = createRenderer(canvas, { wrap, minimap, reveal, routeDebug, landmarks });
// r.setView(view, { reset, dash });  // a new view (reset: a new game, drop tweens and effects)
// r.frame(now);                      // once per animation frame: camera, light easing, draw

// ---------- look: isometric 8-bit ----------
// Everything is drawn in "art pixels" into a small offscreen buffer, which is then
// blitted to the board at an integer scale with smoothing off.

let CAM_MS = 120;       // camera easing time constant
const MINI_MAX = 180;     // longest minimap side in CSS pixels
let FADE_MS = 300;      // time for a cell to reach its new brightness
let BLINK_MS = 120;     // knight blink half-period while hit protection lasts
let COIN_GLOW_MS = 700; // the golden glow after a coin pickup
const TW = 32, TH = 16;           // tile diamond, art px
const HW = TW / 2, HH = TH / 2;
const WALL_H = 11;                // one wall block's height, art px
const MAX_BLOCKS = 2;             // a wall is 1..MAX_BLOCKS blocks tall (z dimension)
const TALL_WALL_SHARE = .25;      // share of walls that are MAX_BLOCKS tall; the rest are 1 block
const BANDS = 8;                  // light bands for known cells
const FOG_BANDS = 5;              // glow bands for unknown cells (distance 1..5 to known)
const FOG_PAD = FOG_BANDS;        // the glow may spill this far past the map edge
const FLOOR_VARIANTS = 6;
let TWEEN_MS = 150;             // entity move tween
let BOB_PX = 2, BOB_MS = 1600;  // ghost hover
let ANIM_MS = 260;              // idle animation frame time
let WALK_MS = 620;              // a troll's stride after each step: feet cycle through the walk frames (it steps slowly)
const ATTACK_MS = 560, ATTACK_WINDUP_MS = 120; // a troll's attack pose while it strikes: wind-up, then the punch lands with the slash
let STRIKE_MS = 800;            // strike overlay: held at full strength, then fades (STRIKE_HOLD)
const STRIKE_HOLD = .5;           // share of STRIKE_MS before the fade starts
const STRIKE_COLOR = '#ff3a2c', BLOCK_COLOR = '#8fb4ff';
const SHIELD_SLASH_MS = 260;      // the parry crescent: 6 frames like the sword's slash, a little quicker
let SLASH_MS = 340;             // the slash crescent sweeps in the first part of STRIKE_MS, then is gone
export const DASH_MS = 340;
const DASH_FRAMES = 6;
let FIRE_MS = 1490;             // the fire strike's blast: 18 sprite frames (fall, burst, burn, smoke), about 83 ms each
// Slash palette, outer rim to bright core: the explorer's sword is white-blue, a ghost's claw red-white.
const SLASH_COLORS = {
  sword: ['#2a2392', '#5b4fe0', '#a9a4ff', '#ffffff'],
  claw: ['#6b0f12', '#c22a2a', '#ff8f80', '#fff1ea'],
  shield: ['#c98a14', '#ffc633', '#fff0a8', '#ffffff'], // the block spark: the coin gold ramp (the shield's face), rim to core
};
const FACE_X = { right: 1, up: 1, left: -1, down: -1 }; // server facing -> sprite side
let REVEAL_ALPHA = .42;         // cells and ghosts shown only because of "Reveal map"

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
    troll: spriteFrom(20, 24, 10, 23, [
      ['#3f4422', 3, 6, 14, 14], ['#7b8443', 6, 1, 8, 7], ['#ffc633', 8, 4, 2, 1], ['#ffc633', 12, 4, 2, 1], ['#2e4220', 5, 20, 4, 4], ['#2e4220', 11, 20, 4, 4],
    ]),
    tree_giant: spriteFrom(44, 72, 22, 71, [
      ['#1e0f05', 16, 4, 16, 64], ['#603312', 17, 6, 14, 55], ['#4a6a2c', 7, 0, 31, 18],
      ['#93531f', 5, 25, 12, 9], ['#93531f', 31, 25, 10, 9], ['#df9b4a', 22, 19, 2, 2], ['#df9b4a', 28, 19, 2, 2],
      ['#603312', 9, 62, 13, 10], ['#603312', 26, 62, 13, 10],
    ]),
    wolf: spriteFrom(27, 20, 13, 19, [
      ['#414762', 4, 7, 17, 8], ['#9aa1bc', 19, 3, 7, 9], ['#666f95', 19, 0, 3, 5],
      ['#666f95', 4, 14, 3, 6], ['#666f95', 17, 14, 3, 6], ['#ff3b30', 23, 5, 1, 1],
    ]),
    chest: spriteFrom(14, 11, 7, 9, [
      ['#723c15', 1, 1, 12, 9], ['#97551d', 1, 1, 12, 3], ['#ffc633', 1, 4, 12, 1], ['#ffc633', 6, 4, 2, 3],
    ]),
    coin: spriteFrom(7, 7, 3, 5, [
      ['#3a2406', 1, 0, 5, 7], ['#3a2406', 0, 2, 7, 3], ['#ffc633', 1, 2, 5, 3], ['#ffc633', 2, 1, 3, 5],
    ]),
  };
}
export const sprites = fallbackSprites();
// props/index.js rasterises the floor props and wall decor into banded sprites. Loaded like sprites.js: if it fails,
// the game runs without props. Each kind: floor[kind][band], wall[kind].L|R[band], meta[kind] = { frameMs, glow, w, h }.
let propArt = null;
// Resolves when the pixel art and the props are in (or failed to load and the stand-ins stay).
export const ready = Promise.all([
  import('./sprites.js')
    .then((m) => {
      const got = m.buildSprites();
      for (const k of ['knight', 'ghost', 'troll', 'tree_giant', 'wolf', 'chest', 'coin', 'heart', 'fire_strike', 'portal']) if (got?.[k]?.canvas) sprites[k] = got[k];
    })
    .catch((err) => console.warn('sprites.js unavailable, using stand-in shapes:', err)),
  import('./props/index.js')
    .then((m) => m.buildProps({ bands: BANDS, navy: hexRgb(PALETTE.floor[0]), tw: TW, th: TH, wallH: WALL_H, bottomRow }))
    .then((p) => { propArt = p; })
    .catch((err) => console.warn('props/index.js unavailable, drawing without props:', err)),
]);

// The ui.* timing knobs (central config) the page applies after GET /api/ui. Unknown or non-numeric keys are skipped.
export function configureRenderer(c = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && v != null ? Number(v) : d);
  CAM_MS = num(c.camMs, CAM_MS); FADE_MS = num(c.fadeMs, FADE_MS); TWEEN_MS = num(c.tweenMs, TWEEN_MS);
  BOB_MS = num(c.bobMs, BOB_MS); ANIM_MS = num(c.animMs, ANIM_MS); WALK_MS = num(c.walkMs, WALK_MS);
  STRIKE_MS = num(c.strikeMs, STRIKE_MS); SLASH_MS = num(c.slashMs, SLASH_MS); FIRE_MS = num(c.fireMs, FIRE_MS);
  REVEAL_ALPHA = num(c.revealAlpha, REVEAL_ALPHA); BLINK_MS = num(c.blinkMs, BLINK_MS); COIN_GLOW_MS = num(c.coinGlowMs, COIN_GLOW_MS);
}

// ---------- several explorers (multiplayer) ----------
// view.explorers = [{ id, pos, facing, slot (0-3), name, status ('active'|'dead'|'forfeited'|'awaiting_key'), self,
// health, max_health, invulnerable }]. Absent in single player (nothing below runs then). One knight per active or
// awaiting_key explorer, tinted by slot (slot 0 is the original red knight; the others recolour the red plume and
// cape pixels of the same sprite at runtime, sprites.js is untouched); dead and forfeited ones are not drawn. The
// viewer's own explorer (self) is the camera target. A teammate on an unlit cell is an outlined marker (positions
// are global, through walls), never a full knight.
export const SLOT_COLOURS = [
  { dark: '#750b0f', base: '#d11920', light: '#ff6a5e' }, // 0 red (the sprite as drawn)
  { dark: '#17408f', base: '#3d8bff', light: '#7bb6ff' }, // 1 blue
  { dark: '#14602d', base: '#36c25f', light: '#6fe596' }, // 2 green
  { dark: '#4f2a86', base: '#a569e8', light: '#c99bff' }, // 3 violet
];
const slotOf = (slot) => SLOT_COLOURS[((Number(slot) | 0) % SLOT_COLOURS.length + SLOT_COLOURS.length) % SLOT_COLOURS.length];
const tintCache = new WeakMap(); // source canvas -> [slot] -> sprite
const outlineCache = new WeakMap();
function tintedSprite(spr, slot) {
  const k = ((Number(slot) | 0) % SLOT_COLOURS.length + SLOT_COLOURS.length) % SLOT_COLOURS.length;
  if (k === 0 || !spr?.canvas) return spr;
  let per = tintCache.get(spr.canvas);
  if (!per) tintCache.set(spr.canvas, per = []);
  if (per[k]) return per[k];
  const { dark, base } = SLOT_COLOURS[k], d = hexRgb(dark), c = hexRgb(base);
  const out = makeCanvas(spr.canvas.width, spr.canvas.height), g = out.getContext('2d');
  g.drawImage(spr.canvas, 0, 0);
  const img = g.getImageData(0, 0, out.width, out.height), px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], gg = px[i + 1], bb = px[i + 2];
    if (px[i + 3] === 0 || !(r > 90 && r > gg * 1.8 && r > bb * 1.8)) continue; // only the red plume / cape / belt pixels
    const t = Math.max(0, Math.min(1, (r - 117) / (209 - 117))); // #750b0f (shade) .. #d11920 (red)
    const m = mix(d, c, t);
    px[i] = m[0]; px[i + 1] = m[1]; px[i + 2] = m[2];
  }
  g.putImageData(img, 0, 0);
  return (per[k] = { ...spr, canvas: out });
}
// A teammate you cannot see: the knight's silhouette as a 1 px slot-coloured outline over a faint fill.
function outlineSprite(spr, slot) {
  const k = ((Number(slot) | 0) % SLOT_COLOURS.length + SLOT_COLOURS.length) % SLOT_COLOURS.length;
  let per = outlineCache.get(spr.canvas);
  if (!per) outlineCache.set(spr.canvas, per = []);
  if (per[k]) return per[k];
  const w = spr.canvas.width, h = spr.canvas.height, P = 1;
  const src = spr.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] > 0;
  const out = makeCanvas(w + 2 * P, h + 2 * P), g = out.getContext('2d');
  const edge = hexRgb(SLOT_COLOURS[k].light), fill = hexRgb(SLOT_COLOURS[k].dark);
  const img = g.createImageData(out.width, out.height);
  for (let y = -P; y < h + P; y++) {
    for (let x = -P; x < w + P; x++) {
      const i = ((y + P) * out.width + x + P) * 4;
      if (solid(x, y)) img.data.set([fill[0], fill[1], fill[2], 110], i);
      else if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) img.data.set([edge[0], edge[1], edge[2], 255], i);
    }
  }
  g.putImageData(img, 0, 0);
  return (per[k] = { ...spr, canvas: out, anchorX: spr.anchorX + P, anchorY: spr.anchorY + P });
}
// 3x5 pixel lettering for the name tags (A-Z, 0-9, a few signs); anything else is blank.
const TAG_FONT = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101111011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', '-': '000000111000000', _: '000000000000111', '.': '000000000000010', '?': '110001010000010',
};
const TAG_MAX = 8;
function tagText(name) {
  const t = String(name ?? '').toUpperCase().replace(/[^A-Z0-9._?-]/g, '').slice(0, TAG_MAX);
  return t;
}

const frameOf = (spr, now, phase = 0) =>
  spr.frames?.length ? spr.frames[Math.floor(now / ANIM_MS + phase) % spr.frames.length] : spr;

// ---- per renderer state and drawing ----
export function createRenderer(canvas, opts = {}) {
const ctx = canvas.getContext('2d');
if (opts.sprites) Object.assign(sprites, opts.sprites);
const wrapEl = opts.wrap ?? canvas.parentElement;
const revealOn = () => !!opts.reveal?.();
const routeDebugOn = () => !!opts.routeDebug?.();
const landmarkList = () => (opts.landmarks?.() ?? []).filter((l) => Array.isArray(l?.cell));
let game = null;          // the view (publicView plus the optional fields above)
let shown = null;         // displayed brightness per cell, eased toward game.light
const seenStrikes = new Set(); // hosted effect IDs survive SSE/poll repeats
const explorerStrike = (st) => st.by === 'explorer' || (game?.explorers ?? []).some((e) => e.id === st.by);
let strikeFx = null;      // this tick's attacks to flash: { t0, strikes }, null when none
let fireFx = null;        // the fire strike's blast: { t0, cells, centre }, kept past the next views until its 18 frames are done
let dashFx = null;        // the explorer's dash streak, following its actual start and landing cells
let coinGlowAt = -1e9;    // when the knight last picked up a coin (drives the golden glow)
let miniDirty = true;
let miniScale = 1;
const heads = new Map();  // id -> { x, y, alpha } in buf px, refreshed every frame by drawEntity (the page's bubbles read it)
const exList = () => (Array.isArray(game?.explorers) && game.explorers.length ? game.explorers : null);
const selfEx = () => exList()?.find((e) => e.self) ?? null;
const myPos = () => selfEx()?.pos ?? game.pos;
const myFacing = () => selfEx()?.facing ?? game.facing;
const exShown = (e) => e.status === 'active' || e.status === 'awaiting_key';
const mini = opts.minimap ?? null;
const mctx = mini ? mini.getContext('2d') : null;
const tilesImg = document.createElement('canvas');
// ---------- props and wall decor (v4) ----------
// props/index.js rasterises the floor props and wall decor into banded sprites. Loaded like
// sprites.js: if it fails, the game runs without props. Each kind: floor[kind][band],
// wall[kind].L|R[band], meta[kind] = { frameMs, glow, w, h }.

// The view's props and decor, indexed once per new view (never per frame).
let solidProp = null;   // Uint8Array(W*H): 1 where a solid prop stands (tiles say '#' there)
let floorProps = [];    // game.props with .phase
let decorAt = new Map(); // y*W+x -> [decor] of that wall cell
let isoDecor = [];       // decor whose art is already isometric (image-art.js): drawn as entities, not on the face
const ISO_DECOR = new Set(['candle_nook']);
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
  isoDecor = [];
  for (const d of game.decor ?? []) {
    const k = d.y * W + d.x;
    (decorAt.get(k) ?? decorAt.set(k, []).get(k)).push({ ...d, phase: hash(d.x, d.y, 5), blocks: 1 + Math.floor(hash(d.x, d.y, (Number(game.seed) | 0) ^ 0x7b19) * 2) });
    if (ISO_DECOR.has(d.kind)) {
      // Already-isometric decor (the candle nook) is drawn as an entity, and its wall run is always full height so
      // the arch has a wall behind it. Visual only, like every wall height.
      isoDecor.push({ ...d, phase: hash(d.x, d.y, 5) });
      for (const t of [-1, 0, 1]) {
        const [wx, wy] = d.face === 'L' ? [d.x + t, d.y] : [d.x, d.y + t];
        if (wx >= 0 && wy >= 0 && wx < W && wy < H) wallBlocks[wy * W + wx] = MAX_BLOCKS;
      }
    }
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
  const wrap = wrapEl;
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
if (typeof ResizeObserver !== 'undefined' && wrapEl) new ResizeObserver(resizeBoard).observe(wrapEl);

// World art px of a (fractional) grid point. A cell's centre is (x+.5, y+.5).
const isoX = (gx, gy) => (gx - gy) * HW;
const isoY = (gx, gy) => (gx + gy) * HH;

// Characters, tweened in grid space. Keyed by adversary id, '@' for the explorer.
// face: 1 = right, -1 = left (mirrored), from the sign of the screen-x travel.
const actors = new Map();
function actorPos(a, now) {
  let k = Math.min(1, Math.max(0, (now - a.t0) / (a.ms ?? TWEEN_MS)));
  k = k * k * (3 - 2 * k);
  return [a.from[0] + (a.to[0] - a.from[0]) * k, a.from[1] + (a.to[1] - a.from[1]) * k];
}
function moveActor(id, pos, now, snap, ms = TWEEN_MS) {
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
  a.ms = ms;
}
// After each new view. A ghost that was not drawn last time, or jumped, snaps into place
// instead of streaking across the fog.
function syncActors(reset, dash = false) {
  const now = performance.now();
  if (reset) actors.clear();
  const oldPos = actors.get('@')?.to, mine = myPos();
  moveActor('@', mine, now, false, dash ? DASH_MS : TWEEN_MS);
  dashFx = dash && oldPos && (oldPos[0] !== mine[0] || oldPos[1] !== mine[1])
    ? { t0: now, from: [...oldPos], to: [...mine] } : null;
  if (FACE_X[myFacing()]) actors.get('@').face = FACE_X[myFacing()]; // server facing wins when present
  const ids = new Set();
  // Teammates: tweened and faced per explorer id; one that left (dead, forfeited) is forgotten at once.
  for (const ex of exList() ?? []) {
    if (ex.self || !exShown(ex) || !Array.isArray(ex.pos)) continue;
    const key = `e:${ex.id}`;
    ids.add(key);
    const prev = actors.get(key);
    const jumped = prev && Math.abs(ex.pos[0] - prev.to[0]) + Math.abs(ex.pos[1] - prev.to[1]) > 1;
    moveActor(key, ex.pos, now, !prev || jumped);
    if (FACE_X[ex.facing]) actors.get(key).face = FACE_X[ex.facing];
  }
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
  seenStrikes.clear();
  for (const st of game.strikes ?? []) if (st.id) seenStrikes.add(st.id);
  strikeFx = null;
  fireFx = null;
  dashFx = null;
  snapCamera();
}

// A new view arrived (a step): refresh everything derived from it.
function boardUpdate(dash) {
  miniDirty = true; // also covers coin_piles changes: the minimap redraws whenever a view arrives
  computeFog();
  indexProps();
  syncActors(false, !!dash);
  // Only a view that arrives from a step flashes its strikes (a page load does not replay them). A view
  // without strikes leaves a running flash alone, so fast steps don't cut it short.
  const fresh = (game.strikes ?? []).filter((st) => !st.id || !seenStrikes.has(st.id));
  for (const st of fresh) if (st.id) seenStrikes.add(st.id);
  while (seenStrikes.size > 2048) seenStrikes.delete(seenStrikes.values().next().value);
  if (fresh.length) strikeFx = { t0: performance.now(), strikes: fresh };
  // The fire strike plays longer than a step can last, so it has its own clock that later views leave running.
  const fire = fresh.find((st) => st?.skill === 'fire_strike' && Array.isArray(st.cells) && st.cells.length);
  if (fire) fireFx = { t0: performance.now(), cells: fire.cells, centre: Array.isArray(fire.centre) ? fire.centre : null };
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
  if (!spr?.canvas) return;
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
function drawFirePortal(px, py, now, alpha) {
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

// The stone arch stands on the goal cell; only its green magic pulses.
function drawPortal(px, py, now, alpha) {
  const portal = sprites.portal;
  if (!portal?.canvas) return drawFirePortal(px, py, now, alpha);
  const phase = Math.floor(now / 260) % 16;
  const spr = phase < 12 ? portal.frames[phase % 4] : portal.shimmer[phase - 12];
  b.save();
  b.globalCompositeOperation = 'lighter';
  b.fillStyle = '#39ef52';
  for (const [rx, ry, strength] of [[23, 8, .05], [17, 6, .08], [11, 4, .1]]) {
    b.globalAlpha = alpha * strength * (.85 + .15 * Math.sin(now / 210));
    pixelEllipse(px, py, rx, ry);
  }
  b.restore();
  blitSprite(spr, px, py, 1, alpha);
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
  drawFire(cx, cy, now, known, reveal); // a floor-level blast: under every wall and solid prop, so it stops at the walls

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
  for (const [hx, hy] of game.heart_cells ?? []) { // hearts: lit cells only (or Reveal), like coins
    const lit = known(hx, hy);
    if (!(lit || reveal) || game.light[hy]?.[hx] === undefined) continue;
    ents.push({ depth: hx + hy, order: -.5, gx: hx, gy: hy, kind: 'heart', n: 1, face: 1,
      alpha: lit ? Math.min(1, Math.max(.15, shown[hy][hx] / .4)) : REVEAL_ALPHA });
  }
  if (propArt) {
    for (const p of floorProps) {
      if (p.w) { pushForge(ents, p, known, shown, reveal); continue; }
      const looks = propArt.floorVariants[p.kind]; // ore, statue: one look per cell, from the cell's hash
      const art = looks ? looks[Math.floor(p.phase * looks.length) % looks.length] : propArt.floor[p.kind];
      const lit = known(p.x, p.y);
      if (!art || !(lit || reveal)) continue;
      const px = isoX(p.x + .5, p.y + .5) - cx, py = isoY(p.x + .5, p.y + .5) - cy;
      if (px < -40 || py < -10 || px > buf.width + 40 || py > buf.height + 70) continue;
      const s = lit ? shown[p.y][p.x] : 0;
      ents.push({ depth: p.depth, order: -1, kind: 'prop', prop: p.kind, gx: p.x, gy: p.y, art: art[bandOf(s)], face: p.flip ? -1 : 1,
        phase: p.phase, alpha: lit ? Math.min(1, s / .2) : REVEAL_ALPHA });
    }
    // Iso wall decor: anchored on its wall cell's centre, sorted one diagonal later (after the neighbour wall it
    // overhangs, before anything standing in front of it). Face R mirrors the face-L art.
    for (const d of isoDecor) {
      const art = propArt.floor[d.kind];
      const lit = known(d.x, d.y); // like face decor: only once its wall is known
      if (!art || !(lit || reveal)) continue;
      const s = lit ? shown[d.y][d.x] : 0;
      ents.push({ depth: d.x + d.y + 1, order: -2, kind: 'prop', prop: d.kind, gx: d.x, gy: d.y, art: art[bandOf(s)], face: d.face === 'L' ? 1 : -1,
        phase: d.phase, alpha: lit ? Math.min(1, s / .2) : REVEAL_ALPHA });
    }
  }
  for (const ad of drawnAdversaries()) {
    const a = actors.get(ad.id);
    if (!a) continue;
    const [gx, gy] = actorPos(a, now);
    ents.push({ depth: Math.max(a.from[0] + a.from[1], a.to[0] + a.to[1]), order: 1, gx, gy, kind: 'ghost', sub: ad.kind ?? 'ghost', face: a.face, stepAt: a.t0 || undefined,
      id: ad.id, alpha: ad.visible ? 1 : REVEAL_ALPHA, chase: ad.mode === 'chase', brain: !!ad.brain?.on, team: ad.team_visible === true,
      maxHp: (ad.visible || reveal) && ad.max_hp > 0 ? Math.min(8, ad.max_hp) : 0, hp: Number(ad.hp) || 0, level: Math.min(4, Math.max(0, Math.floor(Number(ad.level)) || 0)), phase: hash(ad.id.length, ad.id.charCodeAt(ad.id.length - 1)) });
  }
  const me = actors.get('@'), mine = selfEx(), multi = !!exList();
  if (!mine || exShown(mine)) {
    const [mx, my] = actorPos(me, now);
    ents.push({ depth: Math.max(me.from[0] + me.from[1], me.to[0] + me.to[1]), order: 2, gx: mx, gy: my, kind: 'knight', id: '@', face: me.face,
      alpha: mine?.status === 'awaiting_key' ? .6 : 1, slot: mine?.slot ?? 0, name: multi ? mine?.name : null, ex: mine });
  }
  for (const ex of exList() ?? []) {
    const a = ex.self || !exShown(ex) ? null : actors.get(`e:${ex.id}`);
    if (!a) continue;
    const [gx, gy] = actorPos(a, now);
    const cell = ex.pos.map(Math.floor);
    const lit = known(cell[0], cell[1]) || reveal;
    ents.push({ depth: Math.max(a.from[0] + a.from[1], a.to[0] + a.to[1]), order: 2.1, gx, gy, kind: 'knight', id: `e:${ex.id}`, face: a.face,
      alpha: ex.status === 'awaiting_key' ? .6 : 1, slot: ex.slot, name: ex.name, ex, marker: !lit });
  }
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
  drawRouteSpine(cx, cy);
  drawRouteArrow(cx, cy, now);
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
  const list = landmarkList();
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
    b.fillStyle = l.colour ?? '#c9b8ff';
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
  if (Math.hypot(dx, dy) < 2) { dx = FACE_X[myFacing()] ?? 1; dy = 0; } // no aim known: slash across the cell
  drawCrescent(ox, oy, dx, dy, t, {
    frames: SLASH_FRAMES, sweep: 2.3, reach: Math.min(26, Math.max(13, Math.hypot(dx, dy) * 1.25)),
    wTail: 1.5, wHead: 6, bow: 1.5, pal: SLASH_COLORS[explorerStrike(st) ? 'sword' : 'claw'], alpha: st.result === 'miss' ? .6 : 1,
  });
}

// A slash-shaped streak follows the dash path, with its broad bright head just behind the
// knight. It is drawn in the knight's entity pass before the body, so it never covers the sprite.
function drawDashTrail(px, py, now) {
  if (!dashFx) return;
  const t = (now - dashFx.t0) / DASH_MS;
  if (t >= 1) { dashFx = null; return; }
  const frame = Math.max(0, Math.min(DASH_FRAMES - 1, Math.floor(t * DASH_FRAMES)));
  const progress = (frame + 1) / DASH_FRAMES;
  const dx = (dashFx.to[0] - dashFx.to[1] - dashFx.from[0] + dashFx.from[1]) * HW;
  const dy = (dashFx.to[0] + dashFx.to[1] - dashFx.from[0] - dashFx.from[1]) * HH;
  const travel = Math.hypot(dx, dy);
  if (travel < 1) return;
  const ux = dx / travel, uy = dy / travel, nx = -uy, ny = ux;
  const length = Math.min(48, Math.max(12, travel * progress));
  b.globalAlpha = frame >= DASH_FRAMES - 2 ? .55 : 1;
  for (let i = 2; i <= length; i++) {
    const u = 1 - i / length; // thin tail at the old cell, broad head behind the body
    const width = Math.max(1, Math.round(1 + 4 * Math.sin(u * Math.PI / 2)));
    for (let j = -width; j <= width; j++) {
      const edge = Math.abs(j) / width;
      const tone = edge < .22 && u > .35 ? 3 : edge < .5 ? 2 : edge < .8 ? 1 : 0;
      b.fillStyle = SLASH_COLORS.sword[tone];
      b.fillRect(Math.round(px - ux * i + nx * j), Math.round(py - uy * i + ny * j - 10), 1, 1);
    }
  }
  b.globalAlpha = 1;
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
  const [kx, ky] = scr(myPos()[0], myPos()[1]);
  const [ax, ay] = scr(from[0], from[1]);
  let dx = ax - kx, dy = ay - ky;
  if (Math.hypot(dx, dy) < 2) { dx = FACE_X[myFacing()] ?? 1; dy = 0; }
  const face = actors.get('@')?.face ?? 1;
  drawCrescent(kx + face * SHIELD_HOLD_X, ky - SHIELD_TOP + SHIELD_H / 2, dx, dy, t, {
    frames: PARRY_FRAMES, sweep: 1.9, reach: 11, wTail: 1, wHead: 3.5, bow: .8, pal: SLASH_COLORS.shield, alpha: 1,
  });
}

// Fire strike blast: sprites.js ART.fire_strike (18 frames) over FIRE_MS, anchored on the centre of the burnt
// block (strike.centre: the middle of the whole block, the knight's own cell for the 9x9). It is a floor-level effect, so
// it is drawn at the end of Pass A: every wall and solid prop of Pass B covers it (the fire stops at the walls of a
// hallway or a corner) and the characters standing in it draw on top. The sword slash and the claw stay above the walls.
// Fog: drawn only when one of its cells is lit (or Reveal).
function drawFire(cx, cy, now, known, reveal) {
  if (!fireFx) return;
  const art = sprites.fire_strike;
  const frames = art?.frames ?? (art ? [art] : null);
  const f = Math.floor((now - fireFx.t0) / FIRE_MS * (frames?.length ?? 1));
  if (!frames || f >= frames.length) { fireFx = null; return; }
  if (!reveal && !fireFx.cells.some((c) => known(c[0], c[1]))) return;
  // The whole block's middle (strike.centre), so walls that cut cells off do not shift the blast; else the burnt cells' centroid.
  const [mx, my] = fireFx.centre ?? [fireFx.cells.reduce((s, c) => s + c[0], 0) / fireFx.cells.length, fireFx.cells.reduce((s, c) => s + c[1], 0) / fireFx.cells.length];
  const fr = frames[Math.max(0, f)];
  b.drawImage(fr.canvas, Math.round((mx - my) * HW - cx - fr.anchorX), Math.round((mx + my) * HH + HH - cy - fr.anchorY));
}

// pass 'fill' runs in the flats pass, 'edge' after the entities (not for a fire strike's cells); only 'edge' retires strikeFx.
function drawStrikes(cx, cy, now, known, reveal, pass = 'fill') {
  if (!strikeFx) return;
  const k = (now - strikeFx.t0) / STRIKE_MS;
  if (k >= 1) { if (pass === 'edge') strikeFx = null; return; }
  const fade = k < STRIKE_HOLD ? 1 : 1 - (k - STRIKE_HOLD) / (1 - STRIKE_HOLD);
  const flash = k < STRIKE_HOLD && Math.floor(k / STRIKE_HOLD * 4) % 2 ? .7 : 1; // two pulses while held
  for (const st of strikeFx.strikes) {
    if (!Array.isArray(st?.cells)) continue;
    if (pass === 'edge' && st.skill === 'fire_strike') continue; // its cell outlines stay under the walls too (fill pass only)
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
      const blockedClaw = st.result === 'blocked' && !explorerStrike(st);
      if (t < 1 && !blockedClaw && st.skill !== 'fire_strike') drawSlash(st, t, cx, cy, known, reveal); // the fire strike draws its blast instead (drawFire) // a blocked claw shows only the shield's spark
      // A blocked claw: the raised shield parries with a small gold crescent toward the attacker.
      if (blockedClaw && ts < 1 && Array.isArray(st.from) && Array.isArray(myPos())) drawParry(st.from, ts, cx, cy, known, reveal);
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
  const flashing = strikeFx && strikeFx.strikes.some((st) => st.result === 'blocked' && !explorerStrike(st))
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

// Name tag under a knight: dark plate, 3x5 lettering in the slot's light colour, the viewer's own with a lit rim.
function drawNameTag(cx, y, name, slot, alpha) {
  const text = tagText(name);
  if (!text) return;
  const w = text.length * 4 - 1, x0 = cx - (w >> 1), col = slotOf(slot);
  b.save();
  b.globalAlpha = alpha * .85;
  b.fillStyle = PALETTE.brainEdge;
  b.fillRect(x0 - 2, y - 1, w + 4, 7);
  b.globalAlpha = alpha;
  b.fillStyle = col.light;
  for (let i = 0; i < text.length; i++) {
    const g = TAG_FONT[text[i]];
    if (!g) continue;
    for (let k = 0; k < 15; k++) if (g[k] === '1') b.fillRect(x0 + i * 4 + (k % 3), y + Math.floor(k / 3), 1, 1);
  }
  b.fillStyle = col.base;
  b.fillRect(x0 - 2, y + 6, w + 4, 1);
  b.restore();
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
  if (en.kind === 'coin' || en.kind === 'heart') { // a heart hovers exactly like a coin
    const spr = sprites[en.kind];
    const bob = Math.round(Math.sin(now / 380 + en.gx * 1.7 + en.gy * 2.3));
    b.globalAlpha = en.alpha * .7;
    b.fillStyle = PALETTE.shadow;
    pixelEllipse(px, py + 1, 4, 1);
    b.globalAlpha = 1;
    if (en.n > 1) blitSprite(spr, px + 3, py + 1, 1, en.alpha); // a second coin peeks out behind
    blitSprite(spr, px - (en.n > 1 ? 1 : 0), py - 1 + bob, 1, en.alpha);
    return;
  }
  if (en.kind === 'chest') {
    drawPortal(px, py, now, en.alpha);
    return;
  }
  if (en.kind === 'knight') {
    const mineK = en.id === '@';
    const base = frameOf(sprites.knight, now);
    const spr = tintedSprite(base, en.slot);
    if (en.marker) { // a teammate on a dark cell: outline only, no shadow, no effects
      blitSprite(outlineSprite(spr, en.slot), px, py, en.face, .9);
      heads.set(en.id, { x: px, y: py - spr.anchorY, alpha: .6 });
      if (en.name) drawNameTag(px, py + 5, en.name, en.slot, .85);
      return;
    }
    if (mineK) drawDashTrail(px, py, now);
    b.globalAlpha = en.alpha;
    b.fillStyle = PALETTE.shadow;
    pixelEllipse(px, py, 6, 2);
    b.globalAlpha = 1;
    // Hit protection (grace after a hit): the knight blinks.
    const invulnerable = mineK ? (en.ex?.invulnerable ?? game?.invulnerable) : en.ex?.invulnerable;
    const blink = invulnerable && Math.floor(now / BLINK_MS) % 2 === 1;
    blitSprite(spr, px, py, en.face, blink ? .3 : en.alpha);
    if (mineK) drawCoinGlow(px, py, now);
    if (mineK && game?.block) drawShield(px + en.face * SHIELD_HOLD_X, py - SHIELD_TOP, now); // raised on the facing side, below the visor
    heads.set(en.id, { x: px, y: py - spr.anchorY, alpha: 1 });
    if (en.name) drawNameTag(px, py + 5, en.name, en.slot, mineK ? 1 : .9);
    return;
  }
  // Only ghosts hover. Grounded monsters cast shadows sized to their bodies.
  const troll = en.sub === 'troll';
  const giant = en.sub === 'tree_giant';
  const grounded = en.sub !== 'ghost';
  const heightScale = giant ? 3 : troll ? 2 : 1;
  const wave = Math.sin(((now / BOB_MS) + en.phase) * Math.PI * 2);
  const bob = grounded ? 0 : Math.round(wave * BOB_PX);
  b.globalAlpha = en.alpha;
  b.fillStyle = PALETTE.shadow;
  pixelEllipse(px, py, giant ? 12 : troll ? 9 : 6 - (bob < 0 ? 1 : 0), grounded ? 3 : 2);
  if (en.chase) {
    const pulse = .75 + .25 * Math.sin(now / 180);
    b.fillStyle = PALETTE.enemy;
    for (const [rx, ry, a] of [[15, 12, .16], [12, 9, .2], [9, 7, .28]]) {
      b.globalAlpha = en.alpha * a * pulse;
      pixelEllipse(px, py - 10 * heightScale + bob, Math.round(rx * (giant ? 1.7 : troll ? 1.4 : 1)), ry * heightScale);
    }
  }
  b.globalAlpha = 1;
  const art = sprites[en.sub] ?? sprites.ghost;
  // Clamped at 0: a rAF timestamp can be a little older than the performance.now() a step was stamped with,
  // and a negative age would index walk[-1] (undefined) and throw, killing the frame loop.
  const sinceStep = en.stepAt === undefined ? Infinity : Math.max(0, now - en.stepAt);
  // Striking this tick: the attack pose (first frame the wind-up, the rest share what is left of
  // ATTACK_MS), turned toward the struck cells. Strike beats walk beats idle.
  const strike = art.attack && strikeFx?.strikes.find((st) => st.by === en.id);
  const sinceStrike = strike ? Math.max(0, now - strikeFx.t0) : Infinity;
  let face = en.face, spr;
  if (sinceStrike < ATTACK_MS) {
    const n = art.attack.length;
    spr = art.attack[sinceStrike < ATTACK_WINDUP_MS || n === 1 ? 0
      : Math.min(n - 1, 1 + Math.floor((sinceStrike - ATTACK_WINDUP_MS) / ((ATTACK_MS - ATTACK_WINDUP_MS) / (n - 1))))];
    const cells = Array.isArray(strike.cells) ? strike.cells : [];
    if (cells.length && Array.isArray(strike.from)) {
      const sx = cells.reduce((t, c) => t + c[0] - c[1], 0) / cells.length - (strike.from[0] - strike.from[1]);
      if (sx) face = sx > 0 ? 1 : -1;
    }
  } else if (art.walk && sinceStep < WALK_MS) {
    spr = art.walk[Math.min(art.walk.length - 1, Math.floor(sinceStep / (WALK_MS / art.walk.length)))];
  } else spr = frameOf(art, now, en.phase * 4);
  blitSprite(spr, px, py - 2 + bob, face, en.alpha);
  const pipY = py - 2 + bob - spr.anchorY - (en.brain ? 9 : 2) - 3;
  heads.set(en.id, { x: px, y: en.maxHp && en.level ? pipY - 10 : py - 2 + bob - spr.anchorY - (en.brain ? 8 : 0) - (en.maxHp ? 5 : 0), alpha: en.alpha });
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
    // Pixel lettering left aligned above the hp bar, bone coloured, danger red at level 3.
    // Same fog rule as the bar (maxHp is 0 for a monster not drawn / not revealed). No level = no badge.
    if (en.level) {
      const glyphs = ['100100100100111', '000101101101010', '010110010010111', '111001111100111', '111001111001111', '101101111001001'];
      const bx = x0, by = pipY - 8;
      b.fillStyle = PALETTE.brainEdge;
      b.fillRect(bx - 1, by - 1, 17, 7);
      b.fillStyle = en.level >= 3 ? PALETTE.enemy : '#e3daa7';
      // "Lv" followed by the level, using crisp 3x5 glyphs.
      for (const [offset, glyph] of [[0, glyphs[0]], [4, glyphs[1]], [12, glyphs[en.level + 1]]]) {
        for (let i = 0; i < glyph.length; i++) {
          if (glyph[i] === '1') b.fillRect(bx + offset + i % 3, by + Math.floor(i / 3), 1, 1);
        }
      }
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
  // Seen only by a teammate (view.adversaries[].team_visible): a small eye beside the head.
  if (en.team) {
    const ex = px + 9, ey = py - 2 + bob - spr.anchorY + 6; // at head height, clear of the health pips
    b.globalAlpha = en.alpha;
    b.fillStyle = PALETTE.brainEdge;
    b.fillRect(ex - 3, ey - 2, 7, 5);
    b.fillStyle = '#ffe7b0';
    b.fillRect(ex - 2, ey - 1, 5, 3);
    b.fillStyle = PALETTE.brainEdge;
    b.fillRect(ex, ey - 1, 1, 3);
    b.globalAlpha = 1;
  }
}
// ---------- route guidance (spectator) ----------
// view.route (null on an old server or a portal-less arena): a small solid triangle by the knight toward the
// next waypoint, a progress strip, a one-line cue, and (debug toggle only) the hidden spine.
const ROUTE_COLOR = '#ffd98c', ROUTE_EDGE = '#0a1126'; // trail amber on the cold mortar tone
const routeOf = () => {
  const r = game?.route;
  return r && typeof r === 'object' ? r : null;
};
const isCell = (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]);

function pxLine(c, x0, y0, x1, y1) { // 1 px Bresenham line on a 2D context
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    c.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// The portal's own visual wins once it is known, so no arrow then.
function drawRouteArrow(cx, cy, now) {
  const r = routeOf();
  if (!r || !isCell(r.next_waypoint) || r.suppressed === 'portal_known' || r.suppressed === 'over' || game.over) return;
  const me = actors.get('@');
  if (!me) return;
  const [gx, gy] = actorPos(me, now);
  const dx = r.next_waypoint[0] + .5 - (gx + .5), dy = r.next_waypoint[1] + .5 - (gy + .5);
  let sx = isoX(dx, dy), sy = isoY(dx, dy);
  const len = Math.hypot(sx, sy);
  if (len < 1) return;
  sx /= len; sy /= len;
  const bob = Math.floor(now / 260) % 2; // 2-frame idle, like the sprites
  const px = Math.round(isoX(gx + .5, gy + .5)) - cx, py = Math.round(isoY(gx + .5, gy + .5)) - cy - 12; // knight's middle
  const R = 28 + bob; // leave a clear gap around the knight, including the arrow's base and outline
  const tx = px + sx * R, ty = py + sy * R * .75;
  const bx = tx - sx * 5, by = ty - sy * 4, wx = -sy * 3, wy = sx * 2;
  b.save();
  b.globalAlpha = .95;
  for (const [ox, oy, col] of [[1, 0, ROUTE_EDGE], [-1, 0, ROUTE_EDGE], [0, 1, ROUTE_EDGE], [0, -1, ROUTE_EDGE], [0, 0, ROUTE_COLOR]]) {
    b.fillStyle = col;
    const points = [[tx + ox, ty + oy], [bx + wx + ox, by + wy + oy], [bx - wx + ox, by - wy + oy]]
      .map(([x, y]) => [Math.round(x), Math.round(y)]);
    // Fill integer pixels inside the triangle, keeping its edges crisp at every direction.
    const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
      for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
        const sides = points.map(([ax, ay], i) => {
          const [bx, by] = points[(i + 1) % 3];
          return (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        });
        if (sides.every(v => v >= 0) || sides.every(v => v <= 0)) b.fillRect(x, y, 1, 1);
      }
    }
  }
  b.restore();
}

// Debug only: the spine reveals hidden map.
function drawRouteSpine(cx, cy) {
  const r = routeOf();
  if (!r || !routeDebugOn() || !Array.isArray(r.waypoints)) return;
  const pts = r.waypoints.filter(isCell).map(([x, y]) => [Math.round(isoX(x + .5, y + .5)) - cx, Math.round(isoY(x + .5, y + .5)) - cy]);
  if (!pts.length) return;
  b.save();
  b.globalAlpha = .7;
  b.fillStyle = PALETTE.brain;
  for (let i = 1; i < pts.length; i++) pxLine(b, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  for (const [x, y] of pts) b.fillRect(x - 1, y - 1, 3, 3);
  b.restore();
}

function drawRouteMinimapSpine() {
  const r = routeOf();
  if (!r || !routeDebugOn() || !Array.isArray(r.waypoints)) return;
  const pts = r.waypoints.filter(isCell);
  if (!pts.length) return;
  mctx.save();
  mctx.strokeStyle = PALETTE.brain;
  mctx.globalAlpha = .8;
  mctx.lineWidth = 1;
  mctx.beginPath();
  pts.forEach(([x, y], i) => (i ? mctx.lineTo : mctx.moveTo).call(mctx, (x + .5) * miniScale, (y + .5) * miniScale));
  mctx.stroke();
  mctx.restore();
}
// ---------- minimap ----------
// Top-down. Known cells are painted once per change into a W x H offscreen image (1 px
// per cell) on the same warm-to-navy ramp, then scaled up. Markers and the (rotated)
// viewport outline are drawn on top each frame.

const MINI_FLOOR = Array.from({ length: BANDS }, (_, i) => mix(ramp('floorHi', i), ramp('wallTopHi', i), .5));
const MINI_WALL = Array.from({ length: BANDS }, (_, i) => ramp('wallR', i));

function rebuildMinimapTiles() {
  if (!mini) return;
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
  if (!mini) return;
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
  for (const l of landmarkList()) {
    const [x, y] = l.cell;
    if (x < 0 || y < 0 || x >= game.width || y >= game.height || !(game.light[y][x] > 0)) continue;
    mctx.strokeStyle = l.colour ?? '#c9b8ff';
    mctx.lineWidth = 1;
    const r = Math.max(2, s * .9);
    mctx.strokeRect((x + .5) * s - r, (y + .5) * s - r, r * 2, r * 2);
  }
  drawRouteMinimapSpine();
  const team = exList();
  if (team) {
    // Every explorer in its slot colour; the viewer's own is bigger and rimmed in white.
    for (const ex of team) {
      if (!exShown(ex) || !Array.isArray(ex.pos)) continue;
      if (ex.self) { mctx.fillStyle = '#ffffff'; const r = Math.max(3, s * 1.3); mctx.fillRect((ex.pos[0] + .5) * s - r, (ex.pos[1] + .5) * s - r, r * 2, r * 2); }
      dot(ex.pos, slotOf(ex.slot).light, Math.max(2, s) * (ex.self ? 1 : .9));
    }
  } else dot(game.pos, PALETTE.explorer, Math.max(2, s));

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
// ---------- API ----------
function setView(view, { reset = false, dash = false } = {}) {
  game = view ?? null;
  if (!game) return;
  if (reset) resetBoard(); else boardUpdate(dash);
}
let lastFrame = performance.now(), warned = false;
// Once per animation frame. A throwing frame is logged once and never stops later ones.
function frame(now) {
  try {
    if ((window.devicePixelRatio || 1) !== dpr) resizeBoard(); // e.g. moved to another monitor
    const dt = now - lastFrame;
    lastFrame = now;
    moveCamera(dt);
    easeLight(dt);
    draw(now);
  } catch (err) {
    b.setTransform(1, 0, 0, 1, 0, 0); // a throw between save() and restore() would leak the transform
    b.globalAlpha = 1;
    if (!warned) console.error('draw failed:', err);
    warned = true;
  }
}
resizeBoard();
return {
  setView,
  frame,
  resize: resizeBoard,
  snapCamera,
  invalidateMinimap() { miniDirty = true; },
  noteCoin(now = performance.now()) { coinGlowAt = now; },
  forgetActor(id) { actors.delete(id); },
  heads,
  metrics: () => ({ S, dpr, viewW, viewH }),
  get view() { return game; },
};
}
